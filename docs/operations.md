# 运维：SLO、告警和处理步骤

这份文档说明 `/chat` 的服务目标、每条告警的含义和处理步骤，以及数据库的[备份与恢复](#备份与恢复)。规则文件在 [`deploy/prometheus/`](../deploy/prometheus/)，怎么打开指标、怎么接 Prometheus 见 [deployment.md](deployment.md#指标与告警可选)，变量见 [configuration.md](configuration.md#prometheus-指标)。

先说清楚边界：

- 规则没有用 promtool 检查过，也没有在真实的 Prometheus 里加载和求值过。它们只经过 `server/test/metrics-rules.test.mjs`：用一个 YAML 子集解析器读规则，检查每条规则引用的指标和标签都真实存在、`le` 匹配的是真实的桶边界、runbook 里提到的 npm 脚本都存在。
- 下面的目标值是建议值，没有生产流量支撑。所有测量都在一台机器上做，没有 Kubernetes。
- 仓库里没有 Alertmanager 的路由和通知配置，`severity` 标签怎么送到人要自己配。

## 出问题时先看哪里

| 入口 | 说明 |
| --- | --- |
| `GET /livez`（应用端口） | 进程在不在。 |
| `GET /ready`（应用端口） | 能不能接流量。读副本落后、agent 层不可达（拆分部署的入口）只报 `warning`，不会让它变成 503。 |
| `GET /health`（应用端口） | 每个 `checks.*` 的状态和说明：数据库、行级安全、向量库、入库队列（`checks.ingestJobs`）、读副本（`checks.readReplicas`）、agent 层（`checks.agentService`）、拓扑（`checks.serviceTopology`）等。 |
| `GET /metrics`（`METRICS_PORT`，默认 9464） | Prometheus 指标。设了 `METRICS_TOKEN` 时要带 `Authorization: Bearer <token>`。 |
| 进程日志 | 拆分角色的启动健康检查和停机过程带 `[service]` 前缀；指标监听启动时打印 `[metrics] serving /metrics on http://HOST:PORT`。日志、指标标签和跨层的错误里都不带问题、prompt、模型输出、文档内容、租户 id 或密钥。 |
| `GET /usage`（模型网关） | 按租户的模型用量和配额拒绝次数；只接受系统身份、带 admin claim 或 `admin.status.read` 权限的内部 token。 |

## `/chat` 的 SLO（建议值）

两个 SLI 都只看公网入口：单体（`role="all"`）或拆分部署的 api（`role="api"`）。拆分部署时 agent 层会把同一个 `/chat` 再记一次，规则不取它。`role` 来自抓取配置的目标标签，不在序列里，所以每个抓取目标都要带 `role`（见 `deploy/prometheus/prometheus.example.yml`）。

| SLI | 有效请求 | 好请求 | 目标（30 天） |
| --- | --- | --- | --- |
| 可用性 | `/chat` 的请求，去掉 429 和客户端中途离开（`aborted`） | 没有返回 5xx | 99.5%（错误预算 0.5%） |
| 延迟 | `/chat` 的请求，去掉 429；20 秒内就放弃的请求不下结论 | 20 秒内答完；20 秒后才放弃的请求算慢 | 95% 在 20 秒内（预算 5%） |

- 记录规则在 `recording-rules.yml`：`archive_rag:chat_availability_sli:ratio_rate{5m,30m,1h,6h}` 和 `archive_rag:chat_latency_sli:ratio_rate{5m,30m,1h,6h}`。
- 20 秒对应 `server/rag/metrics-http.js` 里 `HTTP_DURATION_BUCKETS` 的一个桶边界，规则测试会检查它还在。桶用 `le=~"20(\\.0)?"` 匹配，因为 Prometheus 3 入库时会把 `le="20"` 规范成 `"20.0"`。
- 分子带 `or vector(0)`：部署后所有 `/chat` 都失败时，"好请求"的序列根本不存在，没有它 SLI 会消失而不是变成 0。
- 一个窗口里没有任何有效请求时没有比值，也就不会告警。
- 已知盲区：客户端超时比 20 秒短时，`/chat` 完全卡死，所有请求都在 20 秒内被放弃，两个 SLI 都看不到。

燃烧率告警（多窗口、多燃烧率）：

| 告警 | 条件 | 持续 | 级别 | 含义 |
| --- | --- | --- | --- | --- |
| `ArchiveRagChatAvailabilityFastBurn` | 1 小时和 5 分钟的错误率都超过 14.4 × 0.5% = 7.2% | 2 分钟 | critical | 照这个速度约 2 天用完一个月的预算 |
| `ArchiveRagChatAvailabilitySlowBurn` | 6 小时和 30 分钟的错误率都超过 6 × 0.5% = 3% | 15 分钟 | warning | 约 5 天用完 |
| `ArchiveRagChatLatencyFastBurn` | 1 小时和 5 分钟里超过 20 秒的比例都超过 14.4 × 5% = 72% | 2 分钟 | critical | 约 2 天用完 |
| `ArchiveRagChatLatencySlowBurn` | 6 小时和 30 分钟里超过 20 秒的比例都超过 6 × 5% = 30% | 15 分钟 | warning | 约 5 天用完 |

critical 表示现在就要有人处理，warning 进工单队列。

## 运维告警

| 告警 | 条件 | 持续 | 级别 |
| --- | --- | --- | --- |
| `ArchiveRagIngestDeadLetters` | 死信队列里有任务 | 5 分钟 | warning |
| `ArchiveRagModelCircuitOpen` | 某个模型的熔断没关上（open 或 half_open），并且同一进程的模型调用还在失败 | 5 分钟 | critical |
| `ArchiveRagPostgresReplicaLagHigh` | 某个读副本的延迟超过 `POSTGRES_READ_REPLICA_MAX_LAG_MS` | 5 分钟 | warning |
| `ArchiveRagMetricsTargetDown` | Prometheus 抓不到某个进程 | 2 分钟 | warning |
| `ArchiveRagGatewayQuotaRejectionsSpike` | 模型网关的配额拒绝超过每秒 0.1 次（10 分钟平均） | 10 分钟 | warning |
| `ArchiveRagTenantRefusalsSustained` | 同一种按租户的拒绝（同一个 `reason`）在所有进程合计超过每秒 0.2 次（15 分钟平均） | 15 分钟 | warning |

## 处理步骤

每条告警在 `alert-rules.yml` 的 `runbook` 注解里有英文版；下面是同样的内容。

### `ArchiveRagChatAvailabilityFastBurn` / `SlowBurn`

**含义**：入口对 `/chat` 返回 5xx 的比例超过目标允许的速度。429 和客户端放弃的请求不算。快烧是用户正在看到错误；慢烧是一个稳定但不高的错误率，持续下去一周内会用完本月预算。

依赖故障现在会返回 503（`AGENT_DEPENDENCY_UNAVAILABLE`，带 `Retry-After`），超过请求截止时间返回 504（`AGENT_DEADLINE_EXCEEDED`），两者都算 5xx。以前模型或检索不可用时 `/chat` 返回 200 并请用户批准 Web 搜索，不会出现在这个 SLI 里。

1. **在哪、为什么**：
   - `sum by (role, instance) (rate(archive_rag_http_requests_total{route="/chat",status_class="5xx"}[5m]))`：只集中在一个实例上，先看那台主机。
   - `sum by (reason) (rate(archive_rag_agent_runs_total{outcome="failed"}[5m]))`：`dependency_model`、`dependency_retrieval`、`dependency_database` 指向对应的依赖，`deadline_exceeded` 指向截止时间。
   - 拆分部署时 agent 层整个不可达，入口直接返回 503/504，没有失败的运行；看 `sum by (tier, code) (rate(archive_rag_service_client_calls_total[5m]))`。
2. **依赖**：
   - 模型：`sum by (model, status) (rate(archive_rag_model_calls_total{metering!="mirror"}[5m]))`、`archive_rag_model_circuits{state="open"}`。
   - 数据库：`sum by (sqlstate_class) (rate(archive_rag_postgres_statement_errors_total[5m]))`、`archive_rag_postgres_pool_clients{state="waiting"}`。
3. **每个进程的健康**：`curl -s http://<host>:<PORT>/health` 看每个 `checks.*` 和它的 message，再看 `/ready`；拆分部署时 agent、检索层、模型网关也各看一遍。开启 API auth 时，要带上单个共享的 `API_AUTH_TOKEN` 或带 `admin.status.read` 的凭据（`-H "x-api-key: <token>"`），否则只返回 `{status}`。检索层和模型网关的 `/health`（检索层还有 `/ready`）只对带内部身份 token 的请求返回完整报告，`curl` 只拿到 `{status}`；要看细节，在能签名的进程里用 service client 发系统探测（见 docs/deployment.md）。

命令：日志里搜 `[service]` 和 `Failed to`；`cd server && npm run eval:llm-resilience` 在本地假模型上复现 429、503、挂起、主模型宕机等模型故障。慢烧时再看最近的变更：部署、模型或 prompt 变更、索引版本切换（`cd server && npm run vector:index -- status`）；开了 `RAG_OBSERVABILITY_ENABLED=true` 时 `cd server && npm run observability:report` 汇总记录下来的 trace。

### `ArchiveRagChatLatencyFastBurn` / `SlowBurn`

**含义**：大部分（快烧）或相当一部分（慢烧）`/chat` 超过 20 秒。通常是模型慢或在排队，有时是检索或数据库。

1. **模型耗时和排队**：`histogram_quantile(0.95, sum by (le, model) (rate(archive_rag_model_call_duration_seconds_bucket{metering!="mirror"}[5m])))`，以及 `archive_rag_model_guard_waiting`（排在 `RAG_LLM_MAX_CONCURRENCY` 后面的请求）。
2. **检索和数据库**：`histogram_quantile(0.95, sum by (le, route) (rate(archive_rag_retrieval_route_duration_seconds_bucket[5m])))`、候选数 `archive_rag_retrieval_route_candidates`、`archive_rag_postgres_pool_clients{state="waiting"}`、`nodejs_eventloop_delay_p99_seconds`。
3. **负载和循环**：`sum by (role, instance) (archive_rag_http_requests_in_flight)`；`sum by (type) (rate(archive_rag_agent_steps_total[5m]))` 除以运行数，看补检索循环是否让每次运行的模型调用变多。慢烧时和一周前比较（`offset 7d`）。

命令：`cd server && npm run eval:load-test` 在假模型上复现并发下的 `/chat` 延迟；`cd server && npm run bench:pgvector-scale` 单独测数据库检索。`RAG_LLM_MAX_CONCURRENCY` 和 `RAG_LLM_REQUEST_TIMEOUT_MS` 限制模型排队；`AGENT_REQUEST_TIMEOUT_MS` 可以给每个 Agent 请求设上限（超时返回 504，会计入可用性 SLI）。

### `ArchiveRagIngestDeadLetters`

**含义**：`RAG_INGEST_MODE=async` 下，某个入库任务的某个阶段（解析、切块、向量化、写索引）用完了 `RAG_INGEST_<STAGE>_MAX_ATTEMPTS`，进了死信队列。字节和各阶段的输出都保留着；上传者看到的状态是失败。文档在重新入队之前不会被索引。

1. **哪些任务、为什么**：`cd server && npm run ingest:jobs -- dead-letter list --all`（阶段、不含错误信息的原因、尝试次数）。
2. **哪个阶段一直失败**：`sum by (stage, result) (increase(archive_rag_ingest_stage_failures_total[1h]))`。`embed` 指向 embedding 模型（`archive_rag_model_calls_total{operation="embedding",status="error"}`），`parse` 指向 PDF 本身或 docling-serve（`DOCLING_SERVE_URL`），`index` 指向 PostgreSQL（`archive_rag_postgres_statement_errors_total`）。
3. **队列状态**：`curl -s -H "x-api-key: <token>" http://<api-host>:<PORT>/health` 的 `checks.ingestJobs`（开启 API auth 时要带 `admin.status.read` 或单个共享 token 的凭据，否则只返回 `{status}`）；`archive_rag_ingest_jobs` 按状态的数量。多个进程上报的是同一个队列的总数，聚合时用 `max`。

修好原因后重新入队，任务从死掉的那个阶段继续：`cd server && npm run ingest:jobs -- dead-letter requeue <jobId> --all`，或者按租户 `POST /admin/ingest-jobs/<jobId>/requeue`。

### `ArchiveRagModelCircuitOpen`

**含义**：连续 `RAG_LLM_CIRCUIT_FAILURE_THRESHOLD` 次"不可用"错误（5xx、408、超时、连接被拒；429 不算）打开了模型调用守卫的熔断。`RAG_LLM_CIRCUIT_COOLDOWN_MS` 后放一个探测请求（在途时状态是 `half_open`），探测一直失败就一直开着。熔断期间对这个模型的调用立即以 `CIRCUIT_OPEN`（503）失败，或者切到 `OPENAI_CHAT_FALLBACK_MODEL`；对 `/chat` 来说就是 503 `AGENT_DEPENDENCY_UNAVAILABLE`。

为什么条件里有 `half_open` 和"同一进程模型调用在失败"：模型挂起时，探测请求要等 `RAG_LLM_REQUEST_TIMEOUT_MS`（默认 120 秒）才结束，只看 `open` 告警会反复重置；守卫的状态只在下一次调用时更新，事故后没人再调用的模型（比如备用模型）会一直报 open，所以还要求有失败的调用。没有调用之后告警自己恢复。

1. **模型端点在不在**：在同一台主机上 `curl -s <OPENAI_BASE_URL>/models`；拆分部署时看模型网关的 `GET /health`（按上游副本列出守卫状态；只对带内部身份 token 的探测列出，见 docs/deployment.md）。
2. **调用看到了什么**：`sum by (model, operation, status) (rate(archive_rag_model_calls_total[5m]))` 和 `archive_rag_model_call_duration_seconds`；挂起的请求在 `RAG_LLM_REQUEST_TIMEOUT_MS` 时结束。
3. **备用模型和共享**：`OPENAI_CHAT_FALLBACK_MODEL` 有没有设、有没有在回答（`model="openai.chat.fallback"`）；设了 `RAG_SHARED_STATE=redis` 时所有实例共享熔断，否则每个实例各开各的。

注意两套模型名：`archive_rag_model_calls_total` 等用的是注册表里的 id（`openai.chat`、`openai.chat.fallback`、`openai.embedding`）；`archive_rag_model_circuits` 和守卫的在途、排队用的是 provider 的模型名（例如 `qwen2.5:7b`）。

命令：`cd server && npm run eval:llm-resilience` 在本地假模型上演练熔断。

### `ArchiveRagPostgresReplicaLagHigh`

**含义**：某个读副本的重放延迟超过 `POSTGRES_READ_REPLICA_MAX_LAG_MS`，路由器把本该去它的检索送回主库（计入 `archive_rag_postgres_replica_fallbacks_total{reason="lag_exceeded"}`）。回答仍然正确，只是主库多承担了读负载。

1. **主库上**：`psql "$POSTGRES_DATABASE_URL" -c "SELECT application_name, state, write_lag, replay_lag FROM pg_stat_replication"`。
2. **副本上**：`SELECT now() - pg_last_xact_replay_timestamp();`。副本上的长查询可能拖住重放（`max_standby_streaming_delay`）。
3. **回退给主库带来的负载**：`sum by (reason) (rate(archive_rag_postgres_replica_fallbacks_total[5m]))` 和 `archive_rag_postgres_pool_clients{state="waiting"}`。

大批量写入（`cd server && npm run vector:reindex -- --apply`、`npm run vector:index -- build`）是延迟突增最常见的原因，等它们结束或暂停它们。

这条告警不覆盖宕掉的副本：测不出延迟的副本（不可达、不在 recovery）没有延迟序列。宕机要看 `archive_rag_postgres_replica_fallbacks_total{reason=~"replica_down|lag_unknown"}` 和 `/health` 的 `checks.readReplicas`；仓库里没有为它单独写告警。

### `ArchiveRagMetricsTargetDown`

**含义**：Prometheus 2 分钟抓不到某个进程。这段时间这个进程的 SLO 和运维告警都没有数据。可能的原因：进程挂了；没设 `METRICS_ENABLED=true`；`METRICS_HOST` 是回环地址而 Prometheus 在别的主机或容器里；端口不是 `METRICS_PORT`；`METRICS_TOKEN` 不对（401）。

1. **进程在不在**：`curl -s http://<host>:<PORT>/livez`（应用端口，不是指标端口）。
2. **监听有没有起来**：启动日志里找 `[metrics] serving /metrics on http://HOST:PORT`；`curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://<host>:<METRICS_PORT>/metrics | head`。
3. **Prometheus 的 `/targets` 页面**上这个目标最后的错误：401 是 token 不对，连接被拒是 `METRICS_HOST`（容器里用 `0.0.0.0`）或 `METRICS_PORT`。

同一台主机上的多个进程要各用一个 `METRICS_PORT`（或 `0`），端口冲突时进程拒绝启动。

### `ArchiveRagGatewayQuotaRejectionsSpike`

**含义**：模型网关的按 workspace 配额（`MODEL_GATEWAY_QUOTA_REQUESTS_PER_MINUTE`、`MODEL_GATEWAY_QUOTA_TOKENS_PER_MINUTE`、`MODEL_GATEWAY_QUOTA_DAILY_TOKENS`）在拒绝请求，调用方得到 429 `MODEL_GATEWAY_QUOTA_EXCEEDED`，直到窗口重置。这个 workspace 的 Agent 运行会降级或失败；其他 workspace 不受影响；系统调用不受限。

1. **哪个配额**：`sum by (quota) (rate(archive_rag_model_gateway_quota_rejections_total[10m]))`。
2. **哪个 workspace**：模型网关的 `GET /usage` 列出进程启动以来按租户的用量和拒绝次数（指标标签里没有租户）。
3. **配额是不是按进程算的**：没有 `RAG_SHARED_STATE=redis` 时每个网关副本各算各的窗口，实际上限是设定值乘以副本数。

处理：在网关的环境里调高配额并重启，或者找到推高用量的调用方（例如循环跑的后台任务；`cd server && npm run eval:trajectory` 检查预算行为）。

### `ArchiveRagTenantRefusalsSustained`

**含义**：某一种按租户的拒绝持续了 15 分钟（`archive_rag_tenant_refusals_total{reason}`，所有进程合计）。短暂的一阵 429 是限额在正常工作；这条告警只在同一种拒绝一直出现时触发：通常是某个租户一直顶着某个上限（客户端在循环重试），或者一次注册表、成员关系的改动把某个租户挡在了外面。`reason` 就是被拒的客户端看到的稳定错误码：

- 限额类：`TENANT_RATE_LIMITED`、`TENANT_CONCURRENCY_LIMITED`（`TENANT_RATE_LIMIT_*`、`TENANT_MAX_CONCURRENT_RUNS`）、`TENANT_TASK_LIMITED`（`TENANT_MAX_QUEUED_TASKS`）、`UPLOAD_SESSION_LIMIT_EXCEEDED`（`UPLOAD_SESSION_MAX_*`）、`INGEST_PENDING_LIMIT_EXCEEDED` / `INGEST_WORKSPACE_PENDING_LIMIT_EXCEEDED`（`RAG_INGEST_MAX_PENDING_*`）、`TENANT_STORAGE_QUOTA_EXCEEDED`（`TENANT_MAX_DOCUMENTS`、`TENANT_MAX_DOCUMENT_BYTES`）、`MODEL_GATEWAY_QUOTA_EXCEEDED`（进程内 `MODEL_QUOTA_ENABLED` 或模型网关，各记一次，不重复）、`MODEL_CALL_QUEUE_FULL`（`RAG_LLM_MAX_QUEUE`，每次被拒的尝试记一次）。
- 成员关系类（`TENANT_MEMBERSHIP=enforce`）：`WORKSPACE_MEMBERSHIP_REQUIRED`、`WORKSPACE_SUSPENDED`、`WORKSPACE_DELETING`、`WORKSPACE_NOT_REGISTERED`、`WORKSPACE_ROLES_LIMIT_EXCEEDED`；`TENANT_REGISTRY_UNAVAILABLE`（503）表示注册表读不出来，所有租户都会被拒，先查数据库。

指标里没有租户标签（注册表拒绝这种标签）。被拒的是哪个租户记在用量账本里：每次拒绝按做出判断时针对的租户（用户和 workspace 这一对）记一条 `refused_<reason>`，和这个租户的其他用量一样按小时汇总、每 `TENANT_USAGE_FLUSH_MS` 刷入数据库。`TENANT_MEMBERSHIP=enforce` 的拒绝只有在请求的 workspace 已登记且不在删除中时才记在这个 workspace 下；否则（客户端随便写的 id、已擦除的 workspace）只记在用户名下，账本里不会出现注册表里没有的 workspace id。

1. **哪个租户**：用平台管理员凭据（`admin.usage.read`）调 `GET /admin/usage?metric=refusals&reason=<reason>&from=<一小时前>`，按拒绝次数列出租户，每行的 `refusals` 是按错误码的次数；`groupBy=workspace` 按 workspace 汇总（按 workspace 计的限额就是这个数）。数据最多滞后 `TENANT_USAGE_FLUSH_MS`。
2. **哪一种、在哪一层**：`sum by (reason, role) (rate(archive_rag_tenant_refusals_total[15m]))`；HTTP 限额对照 `archive_rag_http_requests_total{status_class="429"}`，网关配额对照 `archive_rag_model_gateway_quota_rejections_total`。
3. **是上限设错了还是租户有问题**：拿对应变量和同一页里这个租户的用量比（`metric=chat_requests`、`model_tokens`、`ingested_bytes`）；成员关系类的错误码看 workspace 的状态和用户的成员关系（`cd server && npm run tenant:registry -- members <workspaceId>`、`list --status suspended`）。

处理：上限确实太低就在环境里调高后重启；否则联系那个在循环重试的租户。按 IP 计的拒绝（请求既没有用户也没有 workspace）记在账本的 `('', '')` 下，那一行不对应任何租户。

## 其他常用查询

| 想知道 | 查询 |
| --- | --- |
| 读副本分走了多少读 | `sum by (target) (rate(archive_rag_postgres_reads_total[5m]))` |
| 读为什么回到主库 | `sum by (reason) (rate(archive_rag_postgres_replica_fallbacks_total[5m]))` |
| 层间调用的错误 | `sum by (tier, code) (rate(archive_rag_service_client_calls_total[5m]))`、`rate(archive_rag_service_client_failovers_total[5m])` |
| 运行为什么失败或被取消 | `sum by (outcome, reason) (rate(archive_rag_agent_runs_total[5m]))` |
| 模型 token 和估算成本 | `sum by (model) (rate(archive_rag_model_tokens_total{metering!="mirror"}[1h]))`、`archive_rag_model_estimated_cost_usd_total{metering!="mirror"}` |
| 重排降级 | `rate(archive_rag_retrieval_rerank_degradations_total[5m])` |
| 指标本身出了问题 | `archive_rag_metrics_series_overflow_total`（某个指标族超过 1000 组标签）、`archive_rag_metrics_collector_errors_total` |

跨进程汇总模型指标时排除 `metering="mirror"`：拆分部署下网关记一份权威数据，调用方再记一份镜像。

## 备份与恢复

三个脚本都在 `server/scripts/`，实际工作在 `server/backup-tools.mjs`：

| 命令 | 做什么 |
| --- | --- |
| `npm run backup:postgres -- --database-url <url> [--out <dir>] [--with-files]` | `pg_dump -Fc` 出一个 `.dump`，旁边写 `.manifest.json`。 |
| `npm run backup:verify -- --dump <file>` | 恢复演练：把 dump 恢复到一个一次性集群里并逐项检查。 |
| `npm run backup:restore -- --database-url <目标库> --dump <file> [--dry-run] [--force]` | 恢复到指定的库。 |

数据库地址只从 `--database-url` 或环境变量 `BACKUP_DATABASE_URL` 读，脚本不读 `server/.env`。密码通过 `PGPASSWORD` 交给 `pg_dump`/`pg_restore`，不出现在命令行里；manifest 只记主机、端口和库名。工具自己的连接（统计、角色检查、校验）和 `pg_dump`/`pg_restore` 用的主机、端口、库、用户和密码都只从这个 URL 解析，不会从 shell 里的 `PGHOST`/`PGPORT`/`PGPASSWORD` 补齐，所以不会连到两台不同的服务器；URL 里没有主机（也没有 `?host=<socket 目录>`）的直接拒绝。TLS 与应用一致：环境里开了 `POSTGRES_SSL_ENABLED` 时按 `POSTGRES_SSL_MODE` / `POSTGRES_SSL_CA_FILE` 校验证书，子进程拿到对应的 `PGSSLMODE` / `PGSSLROOTCERT`（`verify-full` 没有 CA 文件时用 `system`，需要 libpq 16），此时 URL 里不能再带 `sslmode` 之类的参数；没开时由 URL 自己的 `sslmode` 决定。`pg_dump`/`pg_restore` 默认取最新的 Postgres.app，`PG_BIN_DIR` 可以指定；`pg_dump` 的大版本不能低于服务器。

### 备份

- 用拥有表的登录（role split 时是迁移登录 `POSTGRES_MIGRATION_DATABASE_URL`）：备份要读到所有租户的行。脚本在会话里设 `row_security = off`，被行策略过滤的登录会直接报错，不会悄悄少算。
- dump 和 manifest 的统计在同一个导出快照里完成（`pg_export_snapshot` + `pg_dump --snapshot`），备份期间有写入也一致。
- manifest 记录：时间、已应用的迁移（`schema_migrations`）、每张表的行数、每个 (owner, workspace) 的文档数（正常的和回收站里的分开）和字节数、每条审计哈希链最后一行的 id 和哈希、行策略引用的角色、dump 的 SHA-256 和大小。
- 默认输出到 `server/backups/`（已在 `.gitignore` 里）。备份写出的每个文件都是 0600，它新建的输出目录是 0700。备份文件里有所有租户的文档和文本，存放时要加密、限制访问，并设自己的保留期。
- `--with-files` 另外打包数据库以外的磁盘状态：`UPLOADS_DIRECTORY`（默认 `server/uploads`）、`UPLOAD_SESSION_DIRECTORY`（默认 `server/upload-sessions`）和数据目录（默认 `server/data`：本地索引、文件注册表、JSONL 存储、trace）。默认的 PostgreSQL 部署里这些大多是临时数据；用 local / Qdrant 或文件注册表时才必须带上（Qdrant 自己的数据要另外按 Qdrant 的方式备份）。密钥库和 KMS 主密钥不进这个 tar：按路径排除（`--keystore-dir` / `--kms-master-key-file`，没给就用环境里的 `TENANT_KEYSTORE_DIR` / `TENANT_KMS_MASTER_KEY_FILE`，再没有就用默认位置；脚本不读 `server/.env`，这两个设置在 `.env` 里时要用参数传），按名字排除，并且按内容排除：打包目录里 1 MiB 以内、JSON 的 `format` 是本地 KMS 密钥文件（包括已销毁密钥的墓碑）或主密钥的文件，不论放在哪里、叫什么名字都会排除，manifest 的 `files.keyMaterialExcluded` 只列路径和格式。

### 恢复演练

```bash
cd server
npm run backup:postgres -- --database-url "$BACKUP_DATABASE_URL" --out /srv/backups
npm run backup:verify -- --dump /srv/backups/archive-rag-<时间>.dump
```

`backup:verify` 不带 `--database-url` 时自己起一个一次性集群（和 `run-pgvector-integration.sh` 一样：`$TMPDIR` 下的新数据目录，只监听 `/tmp` 下一个 0700 目录里的 unix socket，trust 认证，所以不需要任何密码），用一个非超级用户登录（拥有临时库，和生产里的迁移登录一样）恢复，然后检查：

1. dump 的 SHA-256 与 manifest 一致（没传 `--dump` 时，检查 manifest 旁边的那个 dump）；manifest 旁边有 `--with-files` 的 tar 时也校验它的 SHA-256；
2. 代码里每个迁移都已应用、没有未知的迁移，已应用列表与 manifest 一致（旧代码的备份用 `--allow-pending-migrations`）。校验从不迁移恢复出来的库：有待执行的迁移时，第 4 项会先跑迁移，所以跳过（`skipped: "pending_migrations"`），审计链也在不跑迁移的情况下读取；
3. 每张表的行数、每个租户的文档数与 manifest 一致；
4. 健康报告的 `checks.rowLevelSecurity` 没有 error（角色、策略、授权、角色切换）；
5. 审计哈希链全部校验通过（`audit:verify` 的同一段代码），且每条链的最后一行与 manifest 记录的一致，能发现链尾被删的行。

全部通过退出 0，有一项不通过退出 1，脚本出错退出 2。也可以用 `--database-url` 指向一个空的临时库来演练。建议每次备份后自动跑一次，至少定期跑；只有演练通过的备份才算可用。

### 恢复

```bash
npm run backup:restore -- --database-url <目标库> --dump <file> --dry-run   # 只打印计划
npm run backup:restore -- --database-url <目标库> --dump <file>
```

- 先打印计划（目标、dump 和校验和、要建的角色和扩展、`pg_restore` 参数）；dump 与 manifest 的校验和不一致时拒绝。
- 目标库里已经有表时拒绝（退出 3）；`--force` 用 `--clean --if-exists` 覆盖 dump 里的对象。恢复到生产前先停掉所有实例和 ingest worker。
- 缺少行策略引用的 NOLOGIN 角色（租户角色、系统角色）时先创建；缺少 pgvector 时先尝试创建，没有权限时提示由超级用户执行 `CREATE EXTENSION vector`。
- `pg_restore --no-owner --exit-on-error --single-transaction`：要么全部恢复，要么什么都不变；所有对象归恢复所用的登录所有（用迁移登录）。扩展本身和扩展的注释不在恢复里（需要超级用户），由上一步预先创建。
- 最后把租户角色授给恢复所用的登录（迁移 013 在原库上做过的事）。角色密码和成员关系是整个集群的，不在 dump 里：role split 时，用新的 `POSTGRES_DATABASE_URL` / `POSTGRES_MIGRATION_DATABASE_URL` 启动应用，迁移器会重新授予运行时登录；运行时登录本身要先建好（`deploy/postgres/create-split-roles.sql`）。
- `--with-files` 的 tar 在停服时解压到对应目录（成员名是 `uploads/`、`upload-sessions/`、`data/`）。
- 恢复的是备份那一刻：之后的上传、删除、租户擦除都不在里面。尤其是备份之后擦除的租户，用旧备份恢复会把它的数据带回来，恢复后要重新执行那些擦除（审计日志里的 `admin.tenant.erased` 记录了是谁）。回收站里的文档按原来的 `deleted_at` 继续计时。

### RPO 和 RTO

- 这里只实现了逻辑备份（`pg_dump`）。RPO 等于两次备份的间隔：每天备份一次，最坏丢一天的写入。RTO 是 `pg_restore` 的时间加上演练检查和启动，随数据量线性增长；只在测试库上量过（几个文档，恢复加检查约 1 秒），没有生产规模的数字，上线前要用接近生产的数据量量一次。
- 生产环境的做法是 PostgreSQL 的物理备份：基础备份加 WAL 归档（`archive_command` / pgBackRest / WAL-G），可以做时间点恢复（PITR），RPO 到秒或分钟级。**本仓库没有实现、配置或测试 WAL 归档和 PITR**，需要部署方用托管数据库的自动备份或上述工具自己配置。逻辑备份仍然有用：跨大版本迁移、恢复演练、把一个库完整搬到别处。
- Redis（`RAG_SHARED_STATE=redis`）不需要备份：熔断器、并发令牌、judge 缓存都会重建。

### 不在备份里的

- **租户密钥库**（信封加密，`TENANT_KEYSTORE_DIR`，在 PostgreSQL 之外）：故意不进数据库备份，也不进 `--with-files` 的 tar（按路径、名字和内容排除，见上面的“备份”）。这样擦除一个租户的密钥，所有备份副本里这个租户加密过的文件字节就再也读不出来（crypto-shredding）。密钥库要单独备份：放在不同的介质上、单独控制访问和保留期，并且擦除租户时把该租户的密钥也从密钥库的备份里删掉，否则粉碎不成立；或者不备份密钥库，接受丢失密钥库等于丢失加密数据。恢复数据库时要配一个包含这些租户密钥的密钥库。注意加密只覆盖文件字节：切块文本、run、反馈等仍以明文在数据库备份里，擦除租户不会改变已有的备份。
- `server/.env` 和其他密钥、角色密码和成员关系、Redis、进程内缓存。
- Qdrant 自己的存储（只在 `VECTOR_STORE_PROVIDER=qdrant` 时有）。

### 按租户恢复

目前**没有**按租户恢复的工具。`npm run tenant:export` 能导出一个租户的全部记录（NDJSON，文档字节是 base64），但没有对应的导入命令；把单个租户的行用 SQL 拷回生产库也没有实现（要处理依赖顺序、行策略、审计哈希链、每个索引版本的切块表和 BM25 统计）。现在能做的：

1. 用 `backup:verify -- --keep-cluster`（或 `backup:restore` 到一个临时库）把整份备份恢复出来；
2. 在临时库上用 `npm run tenant:export -- --workspace <id> [--user <id>] --output <file>` 导出这个租户；
3. 文档可以从导出的字节通过正常的上传接口重新上传（重新切块、重新 embedding，docId 会变）；run、任务、反馈、记忆和审计记录没有导入路径。

完整的按租户恢复需要一个与 `tenant:export` 对称的导入工具，这里没有做。

## 已知限制

- 规则和告警没有在真实的 Prometheus 里跑过（见开头）。
- 指标监听在 `docker-compose.yml` 和 `compose.services.yml` 里都没有打开，也没有 Prometheus 服务；容器部署要自己加 `METRICS_*` 和抓取配置。
- 事件循环 p99 在每次抓取时重置，两个 Prometheus 同时抓同一个进程时各看到约一半的窗口。
- 读副本失败后回退主库的错误不计入 `archive_rag_postgres_statement_errors_total`，只按原因计入回退次数。
- PostgreSQL 语句错误只按错误码分类：写事务回调里抛出的模型超时（`ETIMEDOUT`）会被算成 `network`。
- 层间调用在截止时间已到时，失败转移计数可能多记一次（实际没有再试）。
- 在应用路由之前就返回的请求（鉴权 401、限流 429），只有路径在已知列表里（`/chat`、`/chat/stream`、`/upload`、`/documents` 等）才记路径，其余记为 `unmatched`。
- 不设 `METRICS_TOKEN` 的回环监听不检查 Host 头；按设计暴露内容里没有租户数据。
