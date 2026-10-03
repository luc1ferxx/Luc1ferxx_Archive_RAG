# 运维：SLO、告警和处理步骤

这份文档说明 `/chat` 的服务目标、每条告警的含义和处理步骤。规则文件在 [`deploy/prometheus/`](../deploy/prometheus/)，怎么打开指标、怎么接 Prometheus 见 [deployment.md](deployment.md#指标与告警可选)，变量见 [configuration.md](configuration.md#prometheus-指标)。

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
3. **每个进程的健康**：`curl -s http://<host>:<PORT>/health` 看每个 `checks.*` 和它的 message，再看 `/ready`；拆分部署时 agent、检索层、模型网关也各看一遍。

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
3. **队列状态**：`curl -s http://<api-host>:<PORT>/health` 的 `checks.ingestJobs`；`archive_rag_ingest_jobs` 按状态的数量。多个进程上报的是同一个队列的总数，聚合时用 `max`。

修好原因后重新入队，任务从死掉的那个阶段继续：`cd server && npm run ingest:jobs -- dead-letter requeue <jobId> --all`，或者按租户 `POST /admin/ingest-jobs/<jobId>/requeue`。

### `ArchiveRagModelCircuitOpen`

**含义**：连续 `RAG_LLM_CIRCUIT_FAILURE_THRESHOLD` 次"不可用"错误（5xx、408、超时、连接被拒；429 不算）打开了模型调用守卫的熔断。`RAG_LLM_CIRCUIT_COOLDOWN_MS` 后放一个探测请求（在途时状态是 `half_open`），探测一直失败就一直开着。熔断期间对这个模型的调用立即以 `CIRCUIT_OPEN`（503）失败，或者切到 `OPENAI_CHAT_FALLBACK_MODEL`；对 `/chat` 来说就是 503 `AGENT_DEPENDENCY_UNAVAILABLE`。

为什么条件里有 `half_open` 和"同一进程模型调用在失败"：模型挂起时，探测请求要等 `RAG_LLM_REQUEST_TIMEOUT_MS`（默认 120 秒）才结束，只看 `open` 告警会反复重置；守卫的状态只在下一次调用时更新，事故后没人再调用的模型（比如备用模型）会一直报 open，所以还要求有失败的调用。没有调用之后告警自己恢复。

1. **模型端点在不在**：在同一台主机上 `curl -s <OPENAI_BASE_URL>/models`；拆分部署时看模型网关的 `GET /health`（按上游副本列出守卫状态）。
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

## 已知限制

- 规则和告警没有在真实的 Prometheus 里跑过（见开头）。
- 指标监听在 `docker-compose.yml` 和 `compose.services.yml` 里都没有打开，也没有 Prometheus 服务；容器部署要自己加 `METRICS_*` 和抓取配置。
- 事件循环 p99 在每次抓取时重置，两个 Prometheus 同时抓同一个进程时各看到约一半的窗口。
- 读副本失败后回退主库的错误不计入 `archive_rag_postgres_statement_errors_total`，只按原因计入回退次数。
- PostgreSQL 语句错误只按错误码分类：写事务回调里抛出的模型超时（`ETIMEDOUT`）会被算成 `network`。
- 层间调用在截止时间已到时，失败转移计数可能多记一次（实际没有再试）。
- 在应用路由之前就返回的请求（鉴权 401、限流 429），只有路径在已知列表里（`/chat`、`/chat/stream`、`/upload`、`/documents` 等）才记路径，其余记为 `unmatched`。
- 不设 `METRICS_TOKEN` 的回环监听不检查 Host 头；按设计暴露内容里没有租户数据。
