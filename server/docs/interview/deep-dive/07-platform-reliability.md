# 07 服务拆分、模型网关、可靠性与可观测性

> 范围：服务拆分、模型网关、可靠性与可观测性
>
> 回到 [总手册](../DEEP-DIVE-PLAYBOOK.md)。数字出处以 [CURRENT-TRUTH.md](../CURRENT-TRUTH.md) 和 `docs/evaluation.md` 为准；代码位置写成「路径 + 函数/常量名」，均经核验代理 grep 确认。

## 30 秒讲法

同一个镜像、同一个入口 server.js，用 ARCHIVE_RAG_ROLE 跑成默认单体，或拆成 api / agent / 检索 / 模型网关四层。拆分的好处是只给瓶颈层加副本、故障隔离、模型调用集中管控。我在一台机器上实测过，同样 7 个进程下单体比拆分快 1.56 倍，所以不把拆分当性能优化讲。层间用短期签名 token 带上租户范围，接收端按 SERVICE_CALL_POLICY 一张表决定谁能调谁；可选每层一把 Ed25519 私钥，token 绑定请求，并开防重放。模型调用这边：抖动退避、遵守 Retry-After、超时可重试、空响应重试一次、切备用模型，再加每个端点的并发上限、熔断器和按租户公平排队。本地故障注入下，限流成功率 79% → 100%；主模型宕机 0 → 100%，前提是配了备用模型。最能证明「先测量再优化」的例子：用 pg_stat_statements 定位后，租户路径每个 /chat 的数据库往返 167 → 22，4 实例吞吐 +37.9%。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `server/server.js` | 入口：按 ARCHIVE_RAG_ROLE 启动单体（startMonolith）或动态导入 startServiceRole 跑拆分角色；单体的 SIGTERM 排空（handleShutdownSignals + createGracefulShutdown，INGEST_WORKER_STOP_GRACE_MS 5 s，SHUTDOWN_FINALIZER_MARGIN_MS 3 s） |
| `server/rag/service-topology.js` | 角色与服务 URL：getServiceRole、hostsServiceTier、isRemoteRetrievalEnabled、validateServiceTopology（配置错误拒绝启动，不回落单体） |
| `server/rag/service-identity.js` | 层间 token：SERVICE_CALL_POLICY、signServiceToken、verifyServiceToken、requireServiceIdentity、请求绑定 verifyServiceRequestBody / handleServiceRequestBodyError、stripInternalServiceHeadersMiddleware；DEFAULT_SERVICE_TOKEN_TTL_MS 60 s，DEFAULT_SERVICE_TOKEN_CLOCK_SKEW_MS 5 s |
| `server/rag/service-identity-keys.js` | hmac / ed25519 / mixed 三种模式与密钥解析、轮换顺序（写在文件头注释里） |
| `server/rag/service-token-replay.js` | 防重放缓存 createServiceTokenReplayCache：进程内有上限（DEFAULT_SERVICE_REPLAY_CACHE_MAX_ENTRIES 10 万），Redis 用 SET NX PX 跨副本共享，Redis 出错时以本地判定为准 |
| `server/rag/service-client.js` | 层间 HTTP 客户端 createServiceClient：pickReplica 选最少在途的副本、不健康冷却 DEFAULT_SERVICE_COOLDOWN_MS 5 s、只对幂等请求（IDEMPOTENT_METHODS）在字节发出后换副本、buildAttempt 每次尝试重新签 token、注入 traceparent 和 deadline 头；bindServiceTraceContext 也在这个文件 |
| `server/rag/agent-service/edge-router.js` | 公网入口：createAgentEdgeRouter 用 AGENT_EDGE_ROUTES 校验后转发 agent 层；relayEventStream 按 SSE 事件边界中继，上游中断时补 error（SERVICE_STREAM_INTERRUPTED / 502，或 SERVICE_TIMEOUT / 504）+ done |
| `server/rag/agent-service/app.js` | agent 层 createAgentApp，中间件链：requireServiceIdentity → requireForwardedTenantScope → express.json({ verify: verifyServiceRequestBody }) → handleServiceRequestBodyError → bindDatabaseTenant → bindServiceTraceContext → bindServiceCallDeadline |
| `server/rag/agent-service/role-server.js` | startServiceRole、createGracefulShutdown（停止接新连接、定时 closeIdleConnections、排空在途请求，然后跑各个 finalizer） |
| `server/rag/retrieval-service/app.js` | 检索层 createRetrievalApp：maskInvisibleDocIds、请求上限（RETRIEVAL_SERVICE_BODY_LIMIT 4mb）、依赖故障答 424 + dependencyStatus、数据端点 allowSystem: false |
| `server/rag/retrieval-service/wire.js` | 无损编码 encodeWireValue / decodeWireValue（保留 undefined、NaN、±Infinity、-0、Map、$ 键），保证远程结果与进程内 deepStrictEqual |
| `server/rag/retrieval-service/remote-retrieval.js` | 调用方一侧：把检索层返回的 usage 记到当前运行的用量上（chargeRetrievalUsage） |
| `server/rag/model-gateway/app.js` | OpenAI 兼容网关 createModelGatewayApp：chat / embeddings / rerank / usage，进程里跑的是同一份 openai.js 和 model-call-guard；quotas.admit 准入 |
| `server/rag/model-gateway/client.js` | 调用方一侧（getGatewayClient）：本地不重试、不过 guard；unavailableStatuses: [] 防止因模型故障换网关副本重试 |
| `server/rag/model-gateway/upstream-pool.js` | 上游副本池 createUpstreamPool，每个副本一个独立的 guard（guardModelCall 的 key 是 replica.url\|model） |
| `server/rag/model-gateway/quotas.js` | 按 workspace 的配额 createModelGatewayQuotas（MODEL_GATEWAY_QUOTA_REQUESTS_PER_MINUTE / TOKENS_PER_MINUTE / DAILY_TOKENS，引擎在 rag/model-quotas.js） |
| `server/rag/openai.js` | withRetry、computeRetryDelayMs、isRetriableError、isFailoverEligible、routesThroughModelGateway；MAX_RETRIES 3、BACKOFF_BASE_MS 500、BACKOFF_CAP_MS 4000、MAX_RETRY_AFTER_MS 10000；经模型注册表切备用模型 |
| `server/rag/openai-client.js` | parseRetryAfterMs（先判断头是否存在，防 Number(null)=0）、请求超时映射成 ETIMEDOUT、sendToUpstream（每个 chat / embeddings HTTP 请求都过 guardModelCall，并传入 signal） |
| `server/rag/model-call-guard.js` | guardModelCall：熔断器 createCircuitBreaker、并发限制 createConcurrencyLimiter、按租户公平队列 createTenantFairQueue，以及 Redis 共享版 createSharedConcurrencyLimiter / createSharedCircuitBreaker |
| `server/rag/shared-state.js` | Redis 客户端 createSharedRedisClient（commandTimeout 1000、enableOfflineQueue false）与 Lua 脚本（defineSharedStateCommands：archiveSlotAcquire、archiveCircuitPeek/Admit/Failure/Success），whenSharedStateReady 首连最多等 2 s |
| `server/rag/request-deadline.js` | 端到端截止时间与取消：runAgentRequestWithCancellation、resolveAgentRequestDeadline、getRequestBudgetMs |
| `server/rag/dependency-outage.js` | 依赖故障分类 classifyDependencyOutage，describeAgentRequestFailure 映射为 503/504 + Retry-After |
| `server/rag/ingest-job-store.js` | PostgreSQL 任务队列 createPostgresIngestJobStore：claim（FOR UPDATE SKIP LOCKED + 租户公平）、按 job_id+claimed_by+attempt_count 围栏（renew / succeed / fail / release / advanceStage）、completeInTransaction、死信队列、subscribeToEnqueues + pg_notify |
| `server/rag/ingest-worker.js` | createIngestWorker：轮询加唤醒，按任务自己的租户执行四个阶段 |
| `server/rag/ingest-pipeline.js` | createIngestPipeline：parse → chunk → embed → index 四个阶段，每阶段的输出落库 |
| `server/rag/ingest-embedding-batcher.js` | 跨文档 embedding 合批 createEmbeddingBatcher：先占槽再合批，按租户子队列轮转；isBatchWideEmbeddingError 区分整批失败 |
| `server/rag/postgres-notification-listener.js` | createPostgresNotificationListener：连接池外专用的 LISTEN 会话，断线按指数退避重连；通知只当提示用 |
| `server/rag/postgres-replicas.js` | 读副本：buildDocumentFreshnessGuard（REPLICA_BEHIND_SENTINEL，转 integer 失败触发 22P02）、acquireReadReplica、computeReplicaLag、classifyReplicaError、READ_REPLICA_FALLBACK_REASONS |
| `server/rag/postgres.js` | PipelinedQuery：租户设置和语句合成一次往返的扩展协议流水线；queryPostgres、TENANT_PIPELINE_STATUS_ERROR_CODE |
| `server/rag/agent-runs.js` | createAgentRunCursor：请求内的 CAS 乐观基准，不是缓存 |
| `server/rag/postgres-agent-run-store.js` | createPostgresAgentRunStore：写语句用 run_events CTE 返回提交后的行和事件，CAS 前同一往返 FOR NO KEY UPDATE |
| `server/rag/tracing.js` | OTel GenAI span 门面（withSpan、GEN_AI_ATTRIBUTES、getActiveTraceId），不记录任何内容 |
| `server/otel.js` | 按需加载 SDK，getOtlpProtocol 默认 http/protobuf，createTracingShutdownFinalizer |
| `server/rag/metrics.js` | 手写 Prometheus 注册表：FORBIDDEN_LABEL_NAMES，每个指标族最多 DEFAULT_MAX_SERIES_PER_METRIC=1000 组标签，溢出进 _overflow |
| `server/rag/metrics-server.js` | /metrics 走独立端口（DEFAULT_METRICS_PORT 9464），可选 bearer token（timingSafeEqual 常量时间比较） |
| `deploy/prometheus/alert-rules.yml` | 按 SLO 多窗口燃烧率的告警规则（如 ArchiveRagChatAvailabilityFastBurn；从未在真实 Prometheus 或 promtool 里加载过） |
| `server/evaluation/run-api-load-bench.mjs` | 压测：子进程里跑真实 app + 假模型，可选多实例、拆分、读副本；wrapper 脚本可加载 pg_stat_statements |
| `server/evaluation/run-llm-resilience-eval.mjs` | LLM 容错故障注入评测（429、503、挂起、空响应、主模型宕机、饱和） |
| `server/evaluation/run-shared-state-eval.mjs` | 4 个进程对比状态放进程内和放 Redis 的区别 |
| `Dockerfile / docker-compose.yml / compose.services.yml` | 一个镜像对应多种角色；端口默认只绑 127.0.0.1；stop_grace_period 30s；compose.services.yml 只用 docker compose config 校验过 |
| `server/archive-mcp-server.js` | stdio MCP server（archive_ask / archive_list_documents / archive_refresh），只读，调用 server/chat.js 的 chat()，不经 agent 规划器；租户范围只来自 ARCHIVE_MCP_USER_ID / ARCHIVE_MCP_WORKSPACE_ID |
| `src/archiveApi.js / src/components/ChatComponent.jsx` | 前端 streamChat：用 fetch + response.body.getReader() 解析 SSE；ChatComponent 经 streamChatAnswer 处理 trace_step、answer_draft、answer_draft_reset |

## 一次请求怎么经过这里

【拆分部署下的一次 POST /chat/stream】
1) 前端 src/archiveApi.js streamChat：用 fetch 发 POST，不用 EventSource，因为要带 body 和鉴权头；用 response.body.getReader() 按 SSE 事件边界解析 trace_step / answer_draft / result / error / done。
2) api 层 app.js：stripInternalServiceHeadersMiddleware（剥掉所有 x-archive-service-* 头）→ requireApiAuth → bindDatabaseTenant → noStoreTenantData → 租户限流 → createRbacMiddleware → createAgentEdgeRouter：先用 AGENT_EDGE_ROUTES 里的 validateChatRequest 按单体同一套规则校验，再调 getServiceClient('agent').stream()。
3) service-client.js createServiceClient：pickReplica 选在途最少的副本（同数时轮转；冷却中的副本只在还有健康副本时跳过）。buildAttempt 每次尝试都重新 signServiceToken（带 accessScope，aud=agent，iss=api，htm/htu/bdh 绑定请求），propagation.inject 注入 traceparent，另带 x-archive-service-deadline-ms（AGENT_SERVICE_TIMEOUT_MS，默认 300 s）和所有尝试共用的 request-id。POST 不幂等，字节发出后失败不换副本。
4) agent 层 agent-service/app.js：requireServiceIdentity(audience=agent，issuers=AGENT_SERVICE_CALLER_ROLES，即 SERVICE_CALL_POLICY.agent.callers) → requireForwardedTenantScope → express.json({ verify: verifyServiceRequestBody }) → handleServiceRequestBodyError → bindDatabaseTenant → bindServiceTraceContext → bindServiceCallDeadline → routes/chat.js：runAgentRequestWithCancellation → runWithAgentEventSink → buildChatResponse（app-services.js，先刷新注册表，再调 runAgentRag）。
5) 检索：document-rag-execution.js retrieveGlobalContextForQueries 分派到 retrieval-service/remote-retrieval.js → 检索层 requireServiceIdentity(allowSystem: false) → decodeWireValue → maskInvisibleDocIds → retrieve*InProcess（embedQueryCached 经网关，pgvector 稠密 + BM25 融合；如开了副本，走 acquireReadReplica，并在同一往返里先跑 buildDocumentFreshnessGuard）→ encodeWireValue 返回结果和 usage → 调用方 chargeRetrievalUsage 计入运行上限。
6) 生成答案：openai.js completeTextWithMetadata 判断该走网关（routesThroughModelGateway）→ model-gateway/client.js（本地不重试；chat 只在网关副本没收到请求时换副本）→ 网关 createModelGatewayApp：requireServiceIdentity → quotas.admit 配额准入 → 同一份 completeTextWithMetadata（withRetry 退避、Retry-After、空响应重试，失败后 isFailoverEligible 判断是否切备用模型）→ openai-client.js sendToUpstream → upstream-pool → guardModelCall（breaker.isRejecting → limiter.acquire 按租户公平排队 → breaker.admit → send → recordSuccess / recordFailure / abandon）→ 上游模型。网关记 model_gateway_metered 事件，调用方写 model_gateway_mirror 事件。
7) 返回：agent 层发 SSE 的 result 和 done，入口 relayEventStream 按事件边界转发；上游中断时补 error（SERVICE_STREAM_INTERRUPTED，status 502；超时是 SERVICE_TIMEOUT，status 504）和 done。span 链为 invoke_agent → agent.plan → execute_tool → chat / embeddings，跨层用 traceparent 串成一条 trace；开了 METRICS_ENABLED 时，HTTP 请求的 RED 指标写进独立端口的 /metrics。
单体（默认）：第 2–6 步都在进程内完成，没有 token，也没有 HTTP 跳。
【一次异步上传（RAG_INGEST_MODE=async）】POST /upload 校验通过 → ingest-job-store enqueue（INSERT + pg_notify；超过租户待处理上限答 429）→ 返回 202 {jobId} → worker 被 postgres-notification-listener 的 LISTEN 或轮询唤醒 → claim（WITH candidate AS (... ORDER BY 该租户在跑任务数, created_at LIMIT 1 FOR UPDATE OF c SKIP LOCKED) UPDATE ...；租约过期的 running 任务也会被重新认领）→ runWithDatabaseTenant(任务自己的 scope) → parse → chunk → embed（createEmbeddingBatcher 跨文档合批）→ index（commitDocument 与 completeInTransaction 在同一个事务里提交）。每次写都按 job_id + claimed_by + attempt_count 做围栏；某阶段次数用尽进 dead_letter → 客户端轮询 GET /ingest-jobs/:jobId。

## 设计决策

### D1. 一个镜像、一个入口，ARCHIVE_RAG_ROLE 选 all / api / agent / retrieval / model-gateway；只有设了 URL 才走远程，层不调自己；拓扑配置错了直接拒绝启动

**为什么**

默认行为完全不变（单体健康检查仍是 16 项、顺序不变）；同一份 env 能交给所有角色；拆分作为可选的扩容手段，用 parity 测试锁住「结果与单体逐字段一致」

**为什么不用主流替代方案**

多仓库或多镜像的真微服务：维护成本高，行为漂移难测。直接上 K8s 或服务网格：项目没有多机环境，先把层边界和契约做对

**代价**

同机、同样 7 个进程时单体快 1.56 倍；拆成四层相对单体，并发 1 时 p50 +4.3 ms（四层整体的增量，不是每一跳），并发 32 时每请求 CPU +21%；所有层共用一个 PostgreSQL，是共享瓶颈也是单点

**证据**

CURRENT-TRUTH 3.19（eval:load-test:split，单机、假模型、行级安全、每个配置 3 次）；test/service-split.e2e.test.mjs 四层下的回答与单体一致，一个 trace id 贯穿四层

**代码**：server/rag/service-topology.js getServiceRole / hostsServiceTier / validateServiceTopology；server/server.js startMonolith

### D2. 层间身份用自签的短期 token（默认 TTL 60 s），里面带用户的 accessScope；接收端 requireServiceIdentity 统一校验，并按 SERVICE_CALL_POLICY 表限制谁能调谁；支持 hmac、ed25519、mixed 三种模式

**为什么**

租户只能从 token 里来，body 不能指定租户；接收端把 req.accessScope 设成和 requireApiAuth 同样的形状，下游的 RLS 和路由不用改；调用策略表在任何模式下都由接收端执行；ed25519 下被攻破的一层只能冒充自己

**为什么不用主流替代方案**

mTLS 或 SPIFFE 服务网格：只能证明是哪个服务，带不了租户范围，而且项目没有 K8s。把用户的公网 token 透传下去：内部层得懂所有鉴权方式，公网凭据也进了内网。OAuth client credentials：要额外接一个 IdP

**代价**

不是 mTLS，层间不加密，内部端口必须只在内网可达；hmac 下各层持同一组密钥，issuer 是自报的；换密钥要滚动重启三轮

**证据**

test/service-identity-split.test.mjs（ed25519，四个进程，检索层用本地向量库）：截获 token 重放 → SERVICE_TOKEN_REPLAYED；用检索层的密钥冒充 api → SERVICE_TOKEN_KEY_ISSUER；agent 调 agent → 403（docs/evaluation.md「读副本、层间身份、截止时间和指标」）；无性能实测

**代码**：server/rag/service-identity.js SERVICE_CALL_POLICY / signServiceToken / verifyServiceToken / requireServiceIdentity；server/rag/service-identity-keys.js

### D3. 每次尝试重新签 token，并绑定这次请求：htm（方法）、htu（路径 + query 的 SHA-256，因为 query 里可能有问题文本，只传摘要）、bdh（非空 body 的 SHA-256）；ed25519 和 mixed 下默认开防重放（issuer:tokenId 只接受一次，记到过期时间 + 时钟偏差）

**为什么**

截获的 token 拿去打别的路由、换别的 body 都没用；故障转移每次都是新 token，不会误触发重放检测

**为什么不用主流替代方案**

RFC 9421 HTTP Message Signatures 或 DPoP：更标准，但实现量和依赖更大。只靠短 TTL：默认 hmac 现在就是这样，60 s 内同一个请求可以原样重放

**代价**

中间如果有代理改写 body 或路径，调用会全部失败；防重放缓存按进程有上限（默认 10 万条），满了淘汰最老的，会重新打开那些 token 的重放窗口；Redis 出错时以本副本的判定为准，跨副本重放在 Redis 故障期间挡不住

**证据**

审查发现「换个 Content-Type 就能绕过请求体绑定」，已修（CURRENT-TRUTH 3.20）；四进程测试同上；无性能实测

**代码**：server/rag/service-identity.js canonicalizeServiceRequestTarget / digestServiceRequestBody / verifyServiceRequestBody / isServiceReplayCacheEnabled；server/rag/service-token-replay.js createServiceTokenReplayCache

### D4. 客户端自己做负载均衡：每个目标层一个 client，选在途最少的副本（同数轮转）；连接失败或 502/503/504 时把副本标记不健康 5 s；每次调用每个副本最多试一次；连接没建立时任何方法都换副本，字节发出后只有幂等请求才换；GET /chat 显式标 idempotent:false

**为什么**

/chat 会跑 agent，有副作用（写 run 记录和会话记忆），不能在第二个副本上重跑；least-outstanding 对慢请求的长尾比轮询稳

**为什么不用主流替代方案**

DNS 轮询、K8s Service、Envoy sidecar：没有服务发现环境。客户端对所有失败都重试：会把 agent 重复执行一遍

**代价**

副本列表写在环境变量里，增减副本要重启调用方；compose --scale 时多个容器共用一个 DNS 名，客户端把它当一个副本，选择和故障转移都不生效（docs/deployment.md）；agent 层因下游故障答 503，也会被入口当成不健康跳过 5 s

**证据**

审查发现「GET /chat 被当成幂等请求，在第二个副本上重跑 agent」，已修（CURRENT-TRUTH 3.19）；test/service-client.test.mjs

**代码**：server/rag/service-client.js createServiceClient / IDEMPOTENT_METHODS / CONNECT_PHASE_CODES / DEFAULT_SERVICE_COOLDOWN_MS；server/rag/agent-service/edge-router.js AGENT_EDGE_ROUTES

### D5. LLM 重试：最多重试 3 次；等抖动的指数退避（窗口 500 / 1000 / 2000 ms，上限 4 s，一半固定一半随机）；retry-after-ms / Retry-After 作为下限，再随机放大最多一半；服务端要求等待超过 10 s 就直接放弃；请求超时（默认 120 s）映射成 ETIMEDOUT 按可重试处理；可重试状态码是 408/409/429/500/502/503/504；空 completion 重试 1 次；只有可重试错误或熔断打开时，才经模型注册表切到 OPENAI_CHAT_FALLBACK_MODEL

**为什么**

一起失败的客户端不要一起重试；尊重服务端给的节奏；备用模型经注册表，工作区策略照样生效；每个尝试过的模型单独计量

**为什么不用主流替代方案**

OpenAI SDK 自带重试、LangChain 的 withRetry / withFallbacks：会和应用层重试叠加，也绕过注册表策略、计量和 span 事件。项目里的 ArchiveRagChatModel 显式设 maxRetries: 0，并拒绝 withRetry / withFallbacks。LiteLLM router 同理

**代价**

限流场景的 p95 从约 2.5 s 升到约 4.7 s；429 也会切备用模型，备用和主模型共用一个限流器时会加重拥塞

**证据**

CURRENT-TRUTH 3.4（eval:llm-resilience：本地假服务注入故障，每个场景 24 次调用、并发 8、SLO 15 s、三轮平均）：精确 429 79.2% → 100%；主模型宕机 0 → 100%（无备用模型时仍 0%）；20% 请求挂起时 87.5%（p95 15 s）→ 100%（p95 3.4 s）；30% 空响应 62.5% → 91.7%

**代码**：server/rag/openai.js withRetry / computeRetryDelayMs / isRetriableError / isFailoverEligible / MAX_RETRY_AFTER_MS / BACKOFF_CAP_MS；server/rag/openai-client.js parseRetryAfterMs；server/rag/langgraph/model.js ArchiveRagChatModel

### D6. 每个「端点|模型」一个 guard：在途上限默认 8；连续 5 次不可用错误（5xx、408、超时、连接错误）就熔断 30 s，半开时只放一个探测；429 和其他 4xx 不算失败，guard 对它们调用 recordSuccess（会把连续失败计数清零）；空响应在 guard 层是正常返回；调用方自己取消的调用（RequestCancelledError）不算成功也不算失败（abandon）；等待队列按租户公平，RAG_LLM_MAX_QUEUE 限制每个租户的队长

**为什么**

重试救不了两种情况：一是过载，排队请求让后面更慢，超时重试又排回队尾；二是死模型，每次调用都要先把重试计划走完才切备用

**为什么不用主流替代方案**

按 TPM 的令牌桶；自适应并发（AIMD、Netflix concurrency-limits）；opossum 这类熔断库：它们不懂租户公平，也不懂「取消不计失败」

**代价**

上限按在途请求数算，不是按 TPM；上限是静态的，不会根据 429 自适应；连续失败阈值在高错误率下可能误熔断（评测里 40% 返回 503 的场景没有误熔断）；夹在 503 之间的 429 会把连续失败计数清零

**证据**

CURRENT-TRUTH 3.4 第二张表：主模型宕机且有备用时，每次调用的请求数 5.00 → 1.33，p50 2.6 s → 24 ms；饱和时 1.42 → 1.00，p95 5.2 → 3.2 s，服务端峰值排队 16 → 8。CURRENT-TRUTH 3.20：取消曾被记成失败，234 次运行里 226 次直接 503，修复后 0 次

**代码**：server/rag/model-call-guard.js guardModelCall / createCircuitBreaker / createConcurrencyLimiter / createTenantFairQueue / isUnavailableError / isCallerCancellation；server/rag/config.js getLlmMaxConcurrency / getLlmCircuitFailureThreshold / getLlmCircuitCooldownMs

### D7. RAG_SHARED_STATE=redis 时，熔断器、并发上限、评审缓存跨实例共享：每次读改写是一个 Lua 脚本；名额和半开探测都是租约（名额租约 = 请求超时 + 5 s）；命令 1 s 超时、不开离线队列，失败就退回进程内状态；首次使用最多等 2 s 让连接就绪

**为什么**

每个进程 8 个在途，4 个实例就是 32 个，会压垮自托管模型服务；实例崩溃后名额不能永远占着

**为什么不用主流替代方案**

让 Redis 成为硬依赖：Redis 挂了全站挂。独立的限流服务（Envoy global rate limit）：多一个组件

**代价**

跨实例公平只是近似：其他实例释放的名额要等 10–100 ms 的下一次轮询才被看到；Redis 故障期间上限按进程算，总量会超出；等待方的轮询有开销（4 实例、并发 64、模型 800 ms 时约 359 次获取脚本/秒，按等待时长计）

**证据**

CURRENT-TRUTH 3.11（eval:shared-state，4 个进程、本机 Redis，跑两轮）：打到坏模型的请求 21 → 8，p95 1.3 → 0.46 s；饱和时 SLO 内成功率 29.2% → 100%，峰值排队 42 → 8。CURRENT-TRUTH 3.15：整个集群严格 8 个在途，9.94 req/s = 8 / 0.8 s。第一版的启动竞态是评测抓出来的

**代码**：server/rag/shared-state.js createSharedRedisClient / whenSharedStateReady / defineSharedStateCommands；server/rag/model-call-guard.js createSharedConcurrencyLimiter / createSharedCircuitBreaker

### D8. 自研模型网关，进程里跑的就是单体那份 openai.js 和 model-call-guard.js；调用方本地不重试、不过 guard；网关额外提供上游副本池（每个副本独立 guard）、按 workspace 的配额、按租户的用量账本（GET /usage）；网关的计量是权威，调用方另写一条 mirror 事件供运行上限使用

**为什么**

单体和网关走同一份代码，行为可以直接对比；租户从签名 token 来，配额和账本与 RLS 的租户口径一致；不引入外部组件

**为什么不用主流替代方案**

LiteLLM proxy、Portkey、One-API、Envoy AI Gateway：功能多，但租户身份和配额要再对接一层，它们的重试会和应用侧叠加，计量还要对账

**代价**

网关要自己维护，功能远少于 LiteLLM（没有多厂商适配、缓存和 UI）；没有 Redis 时配额和上限按网关进程算；所有总量统计都必须过滤 mirror 事件

**证据**

CURRENT-TRUTH 3.19：模型延迟 800 ms 时网关 ×2 从 9.89–10.06 到 19.44–20.01 req/s，这只是并发上限翻倍；压测里 model.directCalls 为 0；test/model-gateway.test.mjs：经网关与直连的文本和 modelRoute 相同

**代码**：server/rag/model-gateway/app.js createModelGatewayApp；server/rag/model-gateway/client.js getGatewayClient；server/rag/model-gateway/upstream-pool.js createUpstreamPool；server/rag/model-gateway/quotas.js createModelGatewayQuotas

### D9. 检索层的结果用自定义的无损编码传输；别人看不到的 docId 换成不存在的哨兵 id 再检索；依赖故障答 424 并带 dependencyStatus；请求有上限（RETRIEVAL_SERVICE_MAX_*，body 4 MB）

**为什么**

parity 标准是远程结果与进程内结果 deepStrictEqual；别的租户的文档和不存在的文档返回一模一样，在没有 RLS 的 local / Qdrant 上也成立；答 424 是为了不让所有副本共享的下游故障引发层层重试

**为什么不用主流替代方案**

普通 JSON：会丢 Map、undefined、-0。protobuf / gRPC：要写 schema，改动大。只靠 RLS：Qdrant 和 local 没有 RLS

**代价**

自定义编码要自己维护；拆分模式有请求上限而单体没有，两边行为有差异；检索层没有并发上限，也没有准入控制

**证据**

test/retrieval-service.test.mjs 验证 parity；审查发现「检索层接受空 docIds，Qdrant 下会搜到所有租户」，已修（CURRENT-TRUTH 3.19）；无性能实测

**代码**：server/rag/retrieval-service/app.js maskInvisibleDocIds / createRetrievalApp / RETRIEVAL_SERVICE_BODY_LIMIT；server/rag/retrieval-service/wire.js encodeWireValue / decodeWireValue

### D10. 异步入库直接用 PostgreSQL 表做队列：claim 用 FOR UPDATE SKIP LOCKED，在跑任务少的租户优先；之后每次写都按 job_id + claimed_by + attempt_count 围栏；index 阶段在 commitDocument 的写事务里 completeInTransaction；入队和释放时 pg_notify，专用 LISTEN 会话负责唤醒，轮询兜底；四个阶段各自重试，次数用尽进 dead_letter

**为什么**

文档、分块和任务在同一个库，「文档提交」和「任务成功」是同一次 COMMIT，没有消息队列和数据库的双写问题；任务表也在 RLS 下；不需要新基础设施

**为什么不用主流替代方案**

Kafka、RabbitMQ、Redis Streams、BullMQ、Celery：都要处理双写或 outbox。Temporal：太重，项目已经有自己的持久化运行和恢复

**代价**

语义是至少一次投递加幂等提交，不是 exactly-once；NOTIFY 只是提示；PG 成了共享瓶颈；PDF 字节存在任务表里

**证据**

CURRENT-TRUTH 3.15 / docs/evaluation.md「多实例与异步入库」（2 个 API 实例、64 篇、并行度 8、embedding 200 ms、重复 3 次）：从提交到入库完成 p50 同步 1,320 ms，异步 930–947 ms；独立 worker 35.1 篇/秒，同步 24.9（同步与进程内异步 23.2 的区间重叠，不排序）；上传请求从约 257 ms 变成几毫秒的 202。审查修掉「重试时相信进程缓存，把没写进库的文档标成成功」

**代码**：server/rag/ingest-job-store.js createPostgresIngestJobStore（claim / renew / succeed / fail / release / completeInTransaction / subscribeToEnqueues）；server/rag/ingest-worker.js createIngestWorker；server/rag/postgres-notification-listener.js createPostgresNotificationListener

### D11. 跨文档 embedding 合批，先占槽再合批：拿到空闲槽的文本立即单独发；槽满时等着的文本在下一个请求结束后合并发出（受条数和 token 上限约束）；整批级的失败（熔断、限流）让整批失败，其他失败按任务逐个重发，把坏输入隔离到它自己的任务；各租户的子队列轮流取

**为什么**

第一版槽空着也合批，结果每个任务都在等一个更大的请求，反而更慢

**为什么不用主流替代方案**

固定 linger 时间的合批（只在没有自己的并发上限时用）；完全不合批

**代价**

只有并发上限卡住时才有收益

**证据**

CURRENT-TRUTH 3.16 / docs/evaluation.md「索引切换与入库流水线」（2 个独立 worker × 8 路、embedding 200 ms/请求、3 次重复）：上限 8 时开关吞吐一样（64.8 对 65.2 篇/秒，区间重叠）；上限为 2 时 41.7 对 19.6 篇/秒（2.1 倍），64 篇文档的 embedding 请求 26–30 次对 64 次；假模型按请求固定计时，偏向合批，这个倍数是上限；第一版在上限不卡时慢 24%，是审查发现的

**代码**：server/rag/ingest-embedding-batcher.js createEmbeddingBatcher / isBatchWideEmbeddingError

### D12. 读副本只承接带租户、标 readOnly、不在事务里的 pgvector 检索；在同一次流水线往返里先跑新鲜度守卫：副本必须有每篇被检索文档 ≥ 主库注册表里的 content_version，索引指针 ≥ 快照的 generation，不满足时把 'archive_rag_replica_behind' 转 integer 触发 22P02，交回主库；另有按 LSN 采样的延迟上限（默认 2 s）、每副本熔断、池满跳过

**为什么**

要读到自己刚写的内容（刚上传、替换、删除的文档）；守卫和读取在同一次往返里，不额外多一跳

**为什么不用主流替代方案**

pgpool / PgBouncer 读写分离：中间件不知道这次查询依赖哪些文档的哪个版本。写后粘主库 N 秒：只是按时间猜。等待 LSN：要把写入的 LSN 传到别的实例，更复杂

**代价**

只分流了检索语句；主库语句减少没达到事先定的 30%；吞吐没有变快；副本上的语句只有连接超时；暂停回放的集成测试只覆盖两个单体实例，拆分拓扑没测

**证据**

CURRENT-TRUTH 3.20（单体 ×2、行级安全、主库副本同机、每配置 3 次）：主库语句每次 /chat 39.2 → 27.9（−28.8%，目标 30%）；回退原因全是 replica_saturated，因落后回退 0 次；用真实流复制暂停回放做的硬验收通过

**代码**：server/rag/postgres-replicas.js buildDocumentFreshnessGuard / acquireReadReplica / computeReplicaLag / classifyReplicaError / REPLICA_BEHIND_SENTINEL

### D13. 可观测性：tracing.js 只依赖 @opentelemetry/api，OTEL_TRACING_ENABLED=true 才加载 SDK；span 按 GenAI 语义约定，属性只有 id、模型名、token 计数、估算成本和状态；OTLP 默认 http/protobuf；LangSmith 追踪变量为 true 时拒绝启动。指标不用客户端库，注册时拒绝租户、文档、问题、路径这类标签名，每个指标族最多 1000 组标签，多出的进 _overflow；/metrics 走独立端口；按 SLO 多窗口燃烧率告警

**为什么**

trace 后端是新的泄露面；厂商中立，Phoenix、Langfuse、Jaeger 都能接；标签基数在注册时就挡住

**为什么不用主流替代方案**

LangSmith 追踪：LangChain 集成会把 prompt 和输出上报到 LangSmith 服务，项目明确禁止。直接用 Langfuse SDK：绑定厂商、默认记录内容；Langfuse 本身可以自托管，也能通过 OTLP 接本项目的 span。prom-client：不内置禁用标签名和基数上限，要自己再约束

**代价**

告警规则从未在真实 Prometheus 或 promtool 里加载过；compose 里没打开 METRICS；SLO 目标只是建议值；手写的暴露格式要自己维护

**证据**

test/tracing.test.mjs 检查内容泄露；test/metrics-monolith.e2e.test.mjs；指标开销测了不下结论（CURRENT-TRUTH 3.20）；审查修掉「Prometheus 3 存 le=\"20.0\"，延迟 SLI 永远为空」

**代码**：server/rag/tracing.js withSpan / GEN_AI_ATTRIBUTES / getActiveTraceId；server/otel.js getOtlpProtocol；server/rag/langgraph/langsmith-guard.js assertLangSmithTracingDisabled；server/rag/metrics.js FORBIDDEN_LABEL_NAMES / DEFAULT_MAX_SERIES_PER_METRIC；deploy/prometheus/alert-rules.yml

### D14. 端到端截止时间：deadline = min(入站 x-archive-service-deadline-ms, 到达时间 + AGENT_REQUEST_TIMEOUT_MS)；每个出站调用花 min(自身超时, 剩余时间)；运行只在安全点停下；已开始的写工作区 Capability 让它跑完；依赖故障答 503/504 带 Retry-After，不再顶替成「请批准 Web 搜索」

**为什么**

调用方放弃以后，下游不该继续花钱；也不能在副作用执行到一半时打断

**为什么不用主流替代方案**

gRPC 的 deadline：要换整个协议。到处检查 signal：会在副作用中间打断

**代价**

数据库语句不取消；调用方断开不会让检索层停下；这是默认行为变化，以前是 200 加澄清，现在是 503

**证据**

CURRENT-TRUTH 3.20（截止时间 300 ms、假模型 800 ms、并发 4/16、默认熔断配置）：修复后 234 次运行全部以 deadline_exceeded（504）结束，0 次 503，失败延迟 p50 309 / 322 ms；test/agent-cancellation.test.mjs、request-deadline-split.test.mjs

**代码**：server/rag/request-deadline.js runAgentRequestWithCancellation / resolveAgentRequestDeadline / getRequestBudgetMs；server/rag/dependency-outage.js classifyDependencyOutage；server/routes/chat.js describeAgentRouteError

### D15. 先测量再优化数据库往返：run store 的写语句直接返回提交后的行和完整事件列表（CTE，同一往返先 FOR NO KEY UPDATE 锁行）；请求内的 run cursor 只作 CAS 的乐观基准；租户设置和语句用扩展协议的 Parse/Bind/Execute 序列加一个 Sync，一次往返发出

**为什么**

pg_stat_statements 定位到两个来源：每个 /chat 回读 26 次（事件列表 15 次、run 行 11 次），每条租户语句单独一个 4 次往返的短事务

**为什么不用主流替代方案**

加缓存：会读到旧状态。连接级 SET ROLE：连接池复用时会串租户。存储过程：业务逻辑要搬进数据库

**代价**

依赖 pg 内部的 Submittable 接口，升级 pg 要跑线协议测试；单条语句在 Sync 时提交，客户端出错后结果未知；native 绑定退回 4 次往返的路径

**证据**

docs/evaluation.md「每次 /chat 的数据库往返」（并发 1 差值法）：租户路径 167 → 22，owner 路径 46 → 20；吞吐（模型 0 ms、并发 32、前后交替各两次）租户 4 实例 205 → 283 req/s（+37.9%），该配置 PG CPU 每请求 7.7 → 4.0 ms；租户单实例只 +12.6%（瓶颈是单进程 CPU）

**代码**：server/rag/postgres.js PipelinedQuery / queryPostgres / TENANT_PIPELINE_STATUS_ERROR_CODE；server/rag/agent-runs.js createAgentRunCursor；server/rag/postgres-agent-run-store.js createPostgresAgentRunStore；server/test/agent-run-chat-statement-count.test.mjs

### D16. 优雅停机：收到 SIGTERM 后停止接新连接、定时关闭空闲连接、等进行中的请求最多 25 s，同时停 ingest worker（5 s 后把任务交回队列），然后刷 span、关指标端口和连接池；第二个信号，或超过 max(排空窗口, worker 宽限) + 3 s，直接 exit 1；compose 的 stop_grace_period 是 30 s

**为什么**

被切断的 document_rag 步骤不能重放，只能人工恢复

**为什么不用主流替代方案**

收到信号直接退出；交给 K8s preStop

**代价**

只排空 HTTP 请求，进程内的后台 agent 任务仍会被切断，交给启动恢复处理

**证据**

CURRENT-TRUTH 3.25：测试在 /chat 处理到一半时发 SIGTERM，请求 200、运行完成、进程退出码 0（test/monolith-graceful-shutdown.test.mjs）

**代码**：server/rag/agent-service/role-server.js createGracefulShutdown；server/server.js handleShutdownSignals / SHUTDOWN_FINALIZER_MARGIN_MS

## 追问阶梯

按面试官的追问顺序排。先自己出声答一遍，再看要点。⚠ 是这题最容易答错或夸大的地方。

### Q1. 这个项目后端是怎么部署的？单体还是微服务？

*L1 是什么*

- 同一个镜像、同一个入口 server.js，用 ARCHIVE_RAG_ROLE 选角色：all（默认单体）、api、agent、retrieval、model-gateway
- api 负责鉴权、限流、上传、文档、入库任务；agent 负责 runAgentRag、任务和启动恢复；retrieval 负责查询 embedding、稠密 + 稀疏检索、融合和重排；model-gateway 是 OpenAI 兼容网关
- 设了 AGENT_SERVICE_URL、RETRIEVAL_SERVICE_URL 或 MODEL_GATEWAY_URL 才走远程；一层永远不调自己，所以同一份 env 可以交给所有角色
- 拓扑校验不过就拒绝启动，不会悄悄回落成单体
- 一键部署 docker compose --profile app 就是单体加 pgvector；拆分部署用 compose.services.yml
- 另外有一个 stdio MCP server（archive_ask / archive_list_documents / archive_refresh）给外部 Agent 用：只读，调 chat()，不跑我自己的规划器

代码：`server/server.js startMonolith`；`server/rag/service-topology.js getServiceRole / hostsServiceTier / validateServiceTopology`；`server/archive-mcp-server.js`

> ⚠ 不要说「我做了一套微服务架构」。安全说法：默认是单体，拆分是可选的部署形态，四层之间的契约有测试保证和单体结果一致；拆分版的 compose.services.yml 只用 docker compose config 校验过，从没真正构建和启动过。

### Q2. 拆成四层以后性能怎么样？既然更慢，为什么还要拆？

*L2 为什么*

- 同一台机器实测：拆成四层相对单体，并发 1 时 p50 +4.3 ms（12.7 → 17.0），并发 32 时每请求 CPU +21%；同样 7 个进程，单体比拆分快 1.56 倍。拆分不是性能优化
- 价值一：只给瓶颈层加副本。模型延迟为 0 时 agent 层占 84% CPU，agent ×2 吞吐 1.84 倍、×4 2.75 倍；api、检索、网关各扩到 2 都是 1.00 倍
- 价值二：故障隔离。agent 层挂了，文档和上传照常工作；检索层或网关挂了，/chat 返回 503 并带 Retry-After
- 价值三：模型调用集中管控，配额、计量、上游副本池、全局并发上限都在网关
- 判定规则是事先定的：某层扩到 2 个副本，吞吐至少 1.5 倍且 3 次结果的区间不重叠，才算扩容有效

代码：`server/evaluation/run-api-load-bench.mjs`；`server/rag/agent-service/edge-router.js createAgentEdgeRouter`

> ⚠ +4.3 ms 是四层整体相对单体的增量，CURRENT-TRUTH 的标题写成「每多一跳」，讲的时候说「拆成四层」更准。网关 ×2 在模型延迟 800 ms 时的 1.99 倍，来自每个进程的模型并发上限翻倍，不是算力增加；用 Redis 共享一个全局上限时，这个效果就没了。84% 是 claim memo 之前的数，memo 之后 agent 层占 62–67%（不是配对测量）。全部是单机、假模型的结果。

### Q3. 服务间认证为什么不用 mTLS 或 Istio 这类服务网格？自己签 token 安全吗？

*L3 为什么不用 X / 怎么证明*

- 我要的不只是证明「哪个服务在调」，还要把用户的租户范围安全地传到下游；mTLS 只证明服务身份，带不了租户
- token 里有 accessScope、aud（目标层）、iss（调用方角色）和 60 s 的 TTL；接收端 requireServiceIdentity 把 req.accessScope 设成和 requireApiAuth 一样的形状，下游的 RLS 和路由都不用改
- SERVICE_CALL_POLICY 一张表规定谁能调谁：agent 只接受 all / api；retrieval 只接受 agent / all（探测另允许 api）；网关接受 agent / all / api / ingest-worker / retrieval。由接收端执行，任何模式下都生效
- 三种模式：hmac（默认，各层共享密钥，issuer 是自报的）；ed25519（每层一把私钥，公钥绑定到 issuer，被攻破的一层只能冒充自己）；mixed（不停机迁移用）
- 算法按 key 固定，防 alg confusion；签名用 timingSafeEqual 常量时间比较；公网入口第一件事就是剥掉所有 x-archive-service-* 头
- 不依赖服务网格，是因为项目没有 K8s 环境；但内部端口仍然必须只在内网可达

代码：`server/rag/service-identity.js SERVICE_CALL_POLICY / verifyServiceToken / requireServiceIdentity / stripInternalServiceHeadersMiddleware`；`server/rag/service-identity-keys.js`

> ⚠ 不能说「比 mTLS 更安全」。安全说法：这不是 mTLS，层间也没有加密；它解决的是租户范围怎么传、谁能调谁，生产上应该叠在网格的 mTLS 之上。ed25519 只在四个进程的测试里跑通过，而且那次检索层用的是 local 向量库。

### Q4. 你说 token 绑定了请求，那被截获了怎么办？防重放缓存放在哪？Redis 挂了呢？

*L3 为什么不用 X / 怎么证明*

- 每次尝试都重新签 token，并绑定这次请求：htm（方法）、htu（路径加 query 的 SHA-256，因为 query 里可能有问题文本，只传摘要）、bdh（body 的 SHA-256）；接收端在 express.json 的 verify 钩子里比对 body 字节
- 带 bdh 的 token 只接受 application/json：审查发现换个 Content-Type 就能绕过绑定检查，已修
- ed25519 和 mixed 下默认开防重放：issuer:tokenId 只接受一次，记录到过期时间加时钟偏差；有 Redis 时用 SET NX PX 跨副本共享
- 默认 hmac 下防重放是关的：60 s 内，同一个请求原样重放能成功，换路由或换 body 不行（HS256 token 带了绑定时也会校验）
- Redis 出错时以本副本的判定为准：本副本照样挡得住，跨副本的重放在 Redis 故障期间挡不住；缓存满 10 万条就淘汰最老的，那些 token 的重放窗口会重新打开

代码：`server/rag/service-identity.js verifyServiceRequestBody / isServiceReplayCacheEnabled / requireServiceIdentity`；`server/rag/service-token-replay.js createServiceTokenReplayCache`

> ⚠ 不要说「不可能重放」。准确的说法：默认 hmac 下，token 在 60 s 里是 bearer token，但只对同一个请求有效；防重放是可选的，Redis 故障时退化为只靠本副本判定（跨副本 fail-open）。

### Q5. 层间负载均衡怎么做的？失败会重试吗？流式接口怎么转发？

*L2 为什么*

- 客户端负载均衡：选在途请求最少的副本，同数时轮转；连接失败或返回 502/503/504 的副本标记不健康 5 s，只在还有健康副本时才跳过它
- 一次调用里每个副本最多试一次；连接没建立（比如 ECONNREFUSED）时，任何方法都可以换副本；字节已经发出去，就只有幂等请求（GET/HEAD/OPTIONS）才换
- GET /chat 显式标 idempotent:false：它会跑 agent、写 run 记录和会话记忆；审查时发现它曾经被当成普通 GET，在第二个副本上又跑了一遍
- 网关客户端设 unavailableStatuses: []：网关返回 503 说明的是模型不可用，换个网关副本只会把模型再重试一遍
- SSE：入口按事件边界转发；客户端断开就取消上游；上游中途断了，补一个 error（SERVICE_STREAM_INTERRUPTED，status 502；超时是 SERVICE_TIMEOUT，status 504）再加 done
- 前端用 fetch + ReadableStream 自己解析 SSE，不用 EventSource，因为要发 POST body 和鉴权头

代码：`server/rag/service-client.js createServiceClient / IDEMPOTENT_METHODS / CONNECT_PHASE_CODES`；`server/rag/agent-service/edge-router.js AGENT_EDGE_ROUTES / relayEventStream`；`src/archiveApi.js streamChat`

> ⚠ compose --scale 时多个容器共用一个 DNS 名，客户端把它当成一个副本，最少在途和故障转移都不生效，只有在环境变量里把 URL 显式列出来才生效。还有一点：agent 层因为下游故障返回 503，也会被入口当成不健康跳过 5 s。

### Q6. LLM 调用失败你怎么处理？

*L2 为什么*

- 最多重试 3 次，用等抖动的指数退避：窗口 500 / 1000 / 2000 ms，一半固定一半随机，平均总等待和改之前的固定间隔（250/750/1500 ms）持平
- retry-after-ms / Retry-After 作为等待下限，再随机放大最多一半，免得同一秒被限流的客户端又一起回来；服务端要求等超过 10 s 就直接放弃
- 请求超时（默认 120 s）当成 ETIMEDOUT 重试；空 completion 重试 1 次
- 重试用完后，只对可重试错误或熔断打开的情况切备用模型；切换经过模型注册表，工作区策略同样生效；400、401 和策略拦截不切
- 每个 HTTP 请求都经过 model-call-guard：在途上限 8，连续 5 次不可用就熔断 30 s
- 数字：限流成功率 79% → 100%，主模型宕机 0 → 100%（要配备用模型），请求挂起 87.5% → 100%（p95 15 s → 3.4 s），空响应 62.5% → 91.7%

代码：`server/rag/openai.js withRetry / computeRetryDelayMs / isRetriableError / isFailoverEligible`；`server/rag/openai-client.js parseRetryAfterMs`；`server/rag/model-call-guard.js guardModelCall`

> ⚠ 这些数字来自本地假服务的故障注入（每个场景 24 次调用、并发 8、三轮平均），不是生产流量。主模型宕机能到 100% 是因为有备用模型，没有备用时仍是 0%；代价是限流时 p95 从 2.5 s 升到 4.7 s。讲 Number(null) 等于 0 那个 bug 时，要说是单元测试抓出来的（NARRATIVE-CASES 故事 3）。

### Q7. 为什么不直接用 OpenAI SDK 自带的重试，或者 LangChain 的 withRetry / withFallbacks？429 也切备用模型，不会让拥塞更严重吗？

*L3 为什么不用 X / 怎么证明*

- 两层重试会叠加：SDK 重试 3 次再乘上应用层重试，请求数成倍放大；所以项目里的 ArchiveRagChatModel 显式设 maxRetries: 0，并拒绝 withRetry 和 withFallbacks
- 备用模型必须经过模型注册表，工作区策略和预算拦截同样生效；每个尝试过的模型单独记 LLMOps 事件，返回的 modelRoute 是真正回答的那个模型
- 重试要看得见、也要停得下：每次重试记成 model.retry span 事件；请求的截止时间和 signal 能中断退避
- 429 切备用是有意的取舍：限流一般按模型算，备用模型往往有独立配额；但评测里我故意让备用和主模型共用一个限流器，测的是最坏情况
- 持续过载靠重试兜不住，所以另加了并发上限；熔断器不计 429，因为 429 说明服务在线，交给退避处理
- 还没做的：按 429 自适应调整并发上限（类似 AIMD）

代码：`server/rag/openai.js isFailoverEligible / withRetry`；`server/rag/langgraph/model.js ArchiveRagChatModel`；`server/rag/model-call-guard.js isUnavailableError`

> ⚠ 不要说 LangChain 的重试「不好」。准确的说法：它和我已有的注册表、计量、截止时间不在同一层，两层一起开会放大请求数。

### Q8. 熔断器怎么设计的？为什么被取消的调用不算失败？多实例时怎么办？

*L3 为什么不用 X / 怎么证明*

- 每个「端点|模型」一个 guard；只有不可用错误（5xx、408、超时、连接错误）计入连续失败次数；429 和其他 4xx 在 guard 里按成功记（连续失败计数清零）
- 熔断打开后立刻抛 CIRCUIT_OPEN（503）：同一个模型不再重试，但可以切备用模型；冷却 30 s 后进入半开，只放一个探测请求
- 排队拿到槽位后再 admit 一次：排队期间熔断器可能已经打开了
- 真实缺陷：被截止时间取消的调用曾被记成失败，5 次就把模型熔断 30 s，影响进程里所有租户，234 次运行里 226 次直接 503。修复后取消既不算失败也不算成功，半开探测被取消时把探测名额交还（abandon）
- 多实例：RAG_SHARED_STATE=redis 时熔断和并发上限都放在 Redis，每次读改写是一个 Lua 脚本；名额和探测都是租约（名额租约 = 请求超时 + 5 s），实例崩溃不会永久占着
- Redis 只是优化，不是依赖：命令 1 s 超时、不开离线队列，失败就退回进程内；首次使用最多等 2 s 连接就绪，第一版的启动竞态就是评测抓出来的
- 公平：等待队列按租户分，最久没被服务的租户先拿槽；只有一个租户时就是 FIFO

代码：`server/rag/model-call-guard.js createCircuitBreaker / isCallerCancellation / createTenantFairQueue / createSharedCircuitBreaker / createSharedConcurrencyLimiter`；`server/rag/shared-state.js whenSharedStateReady`

> ⚠ 跨实例的公平只是近似的：本地队列是公平的，实例之间是先来先服务的 ticket 队列，别的实例释放的名额要等 10–100 ms 的轮询才看得到。Redis 挂的时候上限按进程算，总量会超；连续失败阈值在高错误率下可能误熔断；429 和 503 交替出现时，429 会把计数清零、推迟熔断。

### Q9. 模型网关为什么自己写，不用 LiteLLM、One-API 或 Portkey？

*L3 为什么不用 X / 怎么证明*

- 网关进程里跑的就是单体那份 openai.js 和 model-call-guard.js：重试、退避、备用模型、熔断只在网关里执行一次，调用方不重试，不会叠加
- 租户从签名 token 来；配额按 workspace 算（每分钟请求数、每分钟和每天的 token），用量账本按租户记，口径和 RLS 的租户一致
- 上游副本池里每个副本有独立的 guard；网关的计量是权威，调用方写一条 mirror 事件只给运行上限用，所有汇总统计都过滤 mirror
- 任务前缀、查询适配器和 embedding 空间留在调用方处理，网关按收到的文本原样 embed
- 用外部网关的代价：租户身份要再对接一层，计量要对账，它自己的重试会和应用层叠加
- 测试：经网关的 chat 和直连的文本、modelRoute 都相同；压测要求 model.directCalls 必须为 0

代码：`server/rag/model-gateway/app.js createModelGatewayApp`；`server/rag/model-gateway/client.js getGatewayClient`；`server/rag/model-gateway/upstream-pool.js createUpstreamPool`；`server/rag/model-gateway/quotas.js createModelGatewayQuotas`

> ⚠ 不要说「比 LiteLLM 强」。准确的说法：功能远少于 LiteLLM，没有多厂商适配、缓存和 UI；自研是为了单体和网关跑同一份代码、租户口径一致。如果以后要接很多厂商，会把 LiteLLM 放到网关后面当上游。另外，没有 Redis 时配额和上限按网关进程算。

### Q10. 异步入库为什么用 PostgreSQL 做队列，不用 Kafka、RabbitMQ、Celery 或 Temporal？怎么保证一篇文档不会被入两次？

*L3 为什么不用 X / 怎么证明*

- 文档、分块和任务在同一个库里：index 阶段在 commitDocument 的写事务里记录成功（completeInTransaction），「文档提交」和「任务成功」是同一次 COMMIT，不存在消息队列和数据库双写的问题
- claim 是一条带 CTE 的语句：WITH candidate AS (SELECT ... ORDER BY 该租户在跑任务数, created_at LIMIT 1 FOR UPDATE OF c SKIP LOCKED) UPDATE ...；候选包括 queued 和租约已过期的 running 任务
- 租约加围栏：之后所有写（renew、succeed、fail、release、advanceStage）都带上 job_id + claimed_by + attempt_count，丢了租约的旧 worker 写不进去
- 语义是至少一次投递加幂等提交，不是 exactly-once；文档有没有提交以数据库为准，不信进程缓存（审查时修过这个 bug）
- 唤醒：入队和释放时 pg_notify，由连接池外的专用 LISTEN 会话接收（断线按指数退避重连）；通知只是提示，轮询兜底
- 四个阶段 parse、chunk、embed、index 各自存输出、各自有重试预算；次数用尽进 dead_letter，保留字节，可以从失败的阶段重新排队
- 效果：p50 从 1,320 ms 降到 930–947 ms；独立 worker 35.1 篇/秒；上传请求从约 257 ms 变成几毫秒的 202

代码：`server/rag/ingest-job-store.js createPostgresIngestJobStore / claim / completeInTransaction / subscribeToEnqueues`；`server/rag/ingest-worker.js createIngestWorker`；`server/rag/ingest-pipeline.js createIngestPipeline`；`server/rag/postgres-notification-listener.js createPostgresNotificationListener`

> ⚠ 不要说 exactly-once。同步和进程内异步的吞吐区间重叠，不能说「异步吞吐更高」，只能说独立 worker 吞吐最高、异步更早完成一批文档的入库。

### Q11. 入库量放大 100 倍，这个队列哪里先出问题？

*L4 边界 / 规模 / 重做*

- claim 的排序里，对每个候选行都跑一次「这个租户在跑几个任务」的相关子查询，排队越多越贵；而且每次 claim 只拿 1 条（LIMIT 1）
- PDF 字节以 bytea 存在任务表里，会让表、WAL 和备份一起膨胀
- 所有层共用一个 PostgreSQL，入库写入和 /chat 读取抢同一个库
- NOTIFY 只是提示，每个 store 只有一个 LISTEN 会话；高频 NOTIFY 在提交时的开销需要压测验证
- 改法：按租户维护在跑计数或分租户轮转 claim，一次 claim 多条；字节放对象存储，表里只存引用；把入库库和查询库分开，或做分区；任务量真上来以后，再用 outbox 接到专用队列
- embedding 一侧：合批只在并发上限卡住时有用（上限为 2 时 2.1 倍，而且是假模型下的上限），真正的天花板在模型服务

代码：`server/rag/ingest-job-store.js claim`；`server/db/migrations/015_create_rag_ingest_jobs.sql __INGEST_JOBS_TABLE___claim_idx`；`server/rag/ingest-embedding-batcher.js createEmbeddingBatcher`

> ⚠ 这些都是推断，不是实测：拆分模式下的入库压测没做过，也没有百倍规模的测量，不要编数字。

### Q12. 读副本怎么保证用户刚上传的文档马上能问到？为什么不用 pgpool 或 PgBouncer 做读写分离？效果怎么样？

*L3 为什么不用 X / 怎么证明*

- 只有检索语句（pgvector 稠密检索、BM25）走副本，而且必须带租户、标 readOnly、不在事务里；注册表、文档列表、运行和任务的读都留在主库
- /chat 开始时先从主库刷新注册表，拿到每篇文档的 content_version；副本上同一次往返先跑守卫：每篇被检索的文档版本都 ≥ 这个值，索引指针 ≥ 快照的 generation，否则把 'archive_rag_replica_behind' 转 integer 触发 22P02，流水线中止，交回主库
- 这个守卫成立的前提：文档行和它的分块在同一个事务里提交
- 另外还有按 LSN 采样的延迟上限（默认 2 s）、每个副本的熔断器、连接池满就跳过；副本的任何错误都退回主库并计数；配置写错时 fail closed
- 中间件做读写分离，不知道这次查询依赖哪些文档的哪个版本；写后粘主库 N 秒只是按时间猜
- 效果：每次 /chat 的主库语句少了 28.8%，没达到事先定的 30%；所有档位的吞吐都没变快；回退原因全是连接池满（每进程每副本 10 个），因为副本落后而回退 0 次

代码：`server/rag/postgres-replicas.js buildDocumentFreshnessGuard / acquireReadReplica / computeReplicaLag / READ_REPLICA_FALLBACK_REASONS`；`server/rag/retrieval-service/app.js maskInvisibleDocIds`

> ⚠ 一定要主动说：没达标；副本和主库在同一台机器上；CI 里没有副本；副本上的语句只有连接超时；暂停回放的集成测试只覆盖两个单体实例；/chat 开始时的注册表刷新如果失败，这个请求整个只读主库（registry_unverified）。

### Q13. 可观测性怎么做的？为什么不用 LangSmith？Prometheus 为什么不用 prom-client？告警规则验证过吗？

*L3 为什么不用 X / 怎么证明*

- trace 用 OTel，按 GenAI 语义约定：invoke_agent → agent.plan → execute_tool → chat / embeddings，token 和估算成本挂在 span 上，重试是 span 事件；跨层靠注入 traceparent，一个 trace id 贯穿四层
- 不记录问题、prompt、模型输出和文档内容，测试会检查泄露；LangSmith 追踪会把 prompt 和输出上报到 LangSmith 服务，所以追踪变量为 true 时进程直接拒绝启动
- tracing.js 只依赖 @opentelemetry/api，没开追踪时是 no-op；OTLP 默认用 protobuf，因为 Phoenix 的 OTLP/HTTP 不收 JSON
- 指标走独立端口，可以加 token；注册时就拒绝 doc_id、question、path、host 这类标签名；每个指标族最多 1000 组标签，多出的进 _overflow 并计数。手写就是为了把这些规则写死
- SLO：/chat 可用性 99.5%，95% 的请求在 20 s 内（都是建议值）；多窗口燃烧率告警（快烧 1h/5m 14.4 倍，慢烧 6h/30m 6 倍），每条附处置步骤
- 审查修掉的问题：Prometheus 3 存的是 le=20.0，延迟 SLI 永远为空；所有请求都失败时可用性 SLI 不存在，快烧告警触发不了

代码：`server/rag/tracing.js withSpan / GEN_AI_ATTRIBUTES`；`server/otel.js getOtlpProtocol`；`server/rag/langgraph/langsmith-guard.js assertLangSmithTracingDisabled`；`server/rag/metrics.js FORBIDDEN_LABEL_NAMES / DEFAULT_MAX_SERIES_PER_METRIC`；`deploy/prometheus/alert-rules.yml ArchiveRagChatAvailabilityFastBurn`

> ⚠ 告警规则从没在真实 Prometheus 或 promtool 里加载过，只过了测试里自己写的 YAML 子集解析；compose 里没打开 METRICS；SLO 目标没有真实流量做依据；指标开销测了，但不下结论。

### Q14. 你怎么证明一个性能优化真的有效？讲一个例子。

*L4 边界 / 规模 / 重做*

- 起点是压测报告里的一个异常值：走行级安全时每个 /chat 发了 166 条数据库语句
- 用 pg_stat_statements 做差值：跑 300 个请求的计数减去 100 个请求的计数，再除以 200。定位到两个来源：run 存储每个 /chat 回读 26 次（事件列表 15 次、run 行 11 次）；每条租户语句都是一个 4 次往返的短事务
- 改法一：写语句直接返回提交后的行和事件（CTE），同一次往返先 FOR NO KEY UPDATE 锁行，保证返回的事件包含先提交的并发追加；请求内的 run cursor 只作 CAS 的乐观基准，冲突时重新读
- 改法二：租户设置加语句，用扩展协议在一个 Sync 里一次往返发出
- 结果：租户路径 167 → 22，owner 路径 46 → 20；租户 4 实例 205 → 283 req/s（+37.9%），PG 每请求 CPU 7.7 → 4.0 ms；单实例只 +12.6%，因为瓶颈是单个进程的 CPU
- 用测试把它锁住：test/agent-run-chat-statement-count.test.mjs 固定 1 次插入、3 次 CAS、2 次事件追加、0 次读取
- 第二个例子：claim 检查 memo（加一个数字快速路径），每请求 CPU 从 12–13 ms 降到约 5 ms，并发 32 时吞吐约 2.6 倍；判定规则事先定好（CPU 区间不重叠才算更快）

代码：`server/rag/postgres.js PipelinedQuery / queryPostgres`；`server/rag/agent-runs.js createAgentRunCursor`；`server/rag/postgres-agent-run-store.js createPostgresAgentRunStore`；`server/rag/self-check/evidence-context.js createSelfCheckEvidenceContext`

> ⚠ 167 → 22 是并发 1 下数的往返次数；并发 32 时报告里的「DB queries/req」包含后台查询，两者不能混用。流水线依赖 pg 的内部 Submittable 接口，升级 pg 要跑线协议测试；单条语句在 Sync 时提交，客户端出错后结果未知。memo 的 2.6 倍是在假模型、短回答下测的，真实模型的加速比没测；其中数字快速路径约占 0.3–1 ms，大部分来自 memo。

### Q15. 下游挂了或者超时，用户看到什么？截止时间怎么在四层之间传递？

*L4 边界 / 规模 / 重做*

- deadline = min(入站的 x-archive-service-deadline-ms, 到达时间 + AGENT_REQUEST_TIMEOUT_MS)；拆分部署时由入口用 AGENT_SERVICE_TIMEOUT_MS（默认 300 s）设置
- 每个出站调用最多花 min(自己的超时, 剩余时间)，并带上缩短后的 deadline 头和请求的 signal；进行中的模型调用到点被中止
- 运行只在安全点停下：阶段入口、startStep、节点启动、Skill 入口、finalizer 之前；已经开始的写工作区 Capability 让它跑完，之后把运行标为不可重试
- 用户看到的：截止时间到 → 504 AGENT_DEADLINE_EXCEEDED（retryable: true）；客户端离开 → 499，运行标为 canceled（需要 AGENT_CANCEL_ON_DISCONNECT=on，默认关）；依赖故障 → 503 AGENT_DEPENDENCY_UNAVAILABLE 或 504，带 Retry-After 和出故障的依赖名
- 这是默认行为的变化：以前依赖故障时会降级成 200 加「请批准 Web 搜索」，现在直接答 503
- 检索层把依赖故障答成 424，防止调用方对所有副本共享的故障层层重试

代码：`server/rag/request-deadline.js runAgentRequestWithCancellation / resolveAgentRequestDeadline / getRequestBudgetMs`；`server/rag/dependency-outage.js classifyDependencyOutage / describeAgentRequestFailure`；`server/routes/chat.js describeAgentRouteError`

> ⚠ 数据库语句不读 signal，不会被取消；调用方断开不会让检索层停下；v3 统一图里非主节点的依赖故障仍然返回 409；单体默认不绑定截止时间（AGENT_REQUEST_TIMEOUT_MS 默认 0），断开取消默认也关。

### Q16. 如果用户量放大 100 倍、要上多台机器，你怎么改？如果重做，你会改什么？

*L4 边界 / 规模 / 重做*

- 先承认现状：只在一台机器上测过；没有 K8s、服务发现和自动扩缩；副本列表写在环境变量里
- 多机：放到 K8s，层间走网格的 mTLS，现有的签名 token 保留，专门用来传租户范围；用 /ready 摘流量；按 agent 层 CPU 和网关的在途数做水平扩缩
- 共享状态：Redis 必须上（全局模型并发上限、熔断、防重放），否则多副本时配额和上限按进程叠加
- 数据库是唯一的共享瓶颈和单点：调大副本连接池（这次回退全是池满）；入库库和查询库分开；任务字节移到对象存储；评估用 PgBouncer 做事务级连接池
- 模型侧：按在途数的上限要改成按 TPM 或自适应（AIMD）；按租户的配额已经在网关里
- 重做：拆分之前先把单体内的度量做足（claim memo 一项就带来约 2.6 倍，比拆分划算）；网关可能直接用 LiteLLM，前面放自研的租户和配额层；层间协议考虑 gRPC，拿到原生的 deadline；compose.services.yml 要真正构建、启动跑一遍

代码：`server/rag/service-topology.js validateServiceTopology`；`compose.services.yml`；`server/rag/model-call-guard.js createSharedConcurrencyLimiter`；`server/rag/postgres-replicas.js acquireReadReplica`

> ⚠ 不要报没测过的扩展数字。租户设置是事务内生效（set_config(..., true)），理论上兼容 PgBouncer 的事务模式，但 LISTEN 会话需要直连数据库，这两点都要验证后再说。

## 可以引用的数字

| 说什么 | 数字 | 出处 | 前提 / 注意 |
| --- | --- | --- | --- |
| 精确 429（带 retry-after-ms）场景的成功率 | 79.2% → 100%（无备用模型时 83.3%） | CURRENT-TRUTH.md 3.4；docs/evaluation.md「LLM 调用容错：改前 / 改后」 | 本地假服务注入故障，每个场景 24 次调用、并发 8、SLO 15 s、三轮平均；评测里备用模型和主模型共用一个限流器，属于最坏情况 |
| 主模型宕机时的成功率 | 0% → 100% | CURRENT-TRUTH.md 3.4 | 必须配了备用模型；没有备用模型时仍是 0% |
| 20% 请求挂起 / 30% 空响应场景的成功率 | 挂起 87.5%（p95 15 s）→ 100%（p95 3.4 s）；空响应 62.5% → 91.7% | CURRENT-TRUTH.md 3.4 | 同上，故障注入，不是生产流量 |
| 遵守 Retry-After 的代价 | 限流场景 p95 约 2.5 s → 约 4.7 s | CURRENT-TRUTH.md 3.4 | 系统确实按服务端的要求在等 |
| 熔断：主模型宕机且有备用模型时 | 每次调用的请求数 5.00 → 1.33，p50 2.6 s → 24 ms | CURRENT-TRUTH.md 3.4（并发上限与熔断）；docs/evaluation.md「并发上限与熔断：改前 / 改后」 | 成功率本来就是 100%，没变；省的是时间和打到坏端点的请求 |
| 并发上限：自托管服务饱和时 | 每次调用的请求数 1.42 → 1.00，p95 5.2 → 3.2 s，服务端峰值排队 16 → 8 | CURRENT-TRUTH.md 3.4 | 服务端 2 个工作线程、16 个并发调用方；饱和场景是这次新加的，改前改后跑同一份脚本 |
| Redis 共享熔断和并发上限（4 个实例） | 打到坏模型的请求 21 → 8，p95 1.3 → 0.46 s；饱和时 SLO 内成功率 29.2% → 100%，峰值排队 42 → 8 | CURRENT-TRUTH.md 3.11；docs/evaluation.md「多实例共享状态：进程内 / Redis」 | 4 个本机进程、本机 Redis，两轮结果基本一致（表里是第二轮）；第一版有启动竞态，是评测抓出来的 |
| Redis 共享后整个集群的模型在途数严格等于 8 | 9.94 req/s ≈ 8 / 0.8 s | CURRENT-TRUTH.md 3.15（多实例与异步入库）；docs/evaluation.md「多实例与异步入库」 | 4 实例、并发 64、假模型延迟 800 ms；不共享时是每个进程 8 个、集群合计 32 个（39.9 req/s）；等待方约 359 次获取脚本/秒 |
| 拆成四层相对单体的延迟和 CPU 代价 | 并发 1 时 p50 12.7 → 17.0 ms（+4.3），并发 32 时每请求 CPU 11.7 → 14.1 ms（+21%） | CURRENT-TRUTH.md 3.19 | 拆成 4 个进程对单体 1 个进程的整体差值，不是每一跳；单机、假模型、模型延迟 0、行级安全开启，每个配置重复 3 次 |
| 同机、同进程数下单体与拆分的比较 | 单体 ×7 吞吐 398–408 req/s，拆分（agent ×4）256–263 req/s，单体快 1.56 倍 | CURRENT-TRUTH.md 3.19 | 拆分的价值在于只扩瓶颈层和故障隔离，不在效率 |
| 给瓶颈层（agent）加副本 | agent ×2 吞吐 1.84 倍，×4 吞吐 2.75 倍；api、检索、网关各 ×2 都是 1.00 倍 | CURRENT-TRUTH.md 3.19 | ×4 时机器开始用慢核，效率 69% |
| 模型延迟 800 ms 时网关 ×2 | 1.99 倍（9.89–10.06 → 19.44–20.01 req/s） | CURRENT-TRUTH.md 3.19 | 来自每个进程的模型并发上限翻倍，不是算力增加；Redis 共享全局上限时这个效果消失 |
| 每次 /chat 的数据库往返 | 租户路径 167 → 22，owner 路径 46 → 20 | CURRENT-TRUTH.md 3.15；docs/evaluation.md「每次 /chat 的数据库往返」 | pg_stat_statements 在并发 1 下用差值法统计（300 请求减 100 请求，除以 200） |
| 往返优化后的吞吐 | 租户 4 实例 205 → 283 req/s（+37.9%），该配置 PG 每请求 CPU 7.7 → 4.0 ms；租户单实例 +12.6%（PG CPU 6.0 → 2.9 ms） | docs/evaluation.md「每次 /chat 的数据库往返」 | 模型 0 ms、并发 32、每格 3000 请求、前后交替各跑两次；单实例的瓶颈是进程 CPU |
| claim 检查 memo | 每请求应用 CPU 12–13 → 约 5 ms；并发 32 时吞吐 83–94 → 239–258 req/s（约 2.6 倍） | CURRENT-TRUTH.md 3.24；docs/evaluation.md「Claim 检查 memo」 | 单体、pgvector、行级安全、假模型 0 ms，每档重复 3 次且区间不重叠；改动还包含数字快速路径（约 0.3–1 ms），大部分来自 memo；假模型的回答很短，真实模型下的加速比没测 |
| 读副本分流主库 | 每次 /chat 的主库语句 39.2 → 27.9（−28.8%），没达到事先定的 30%；吞吐没有变快 | CURRENT-TRUTH.md 3.20；docs/evaluation.md「读副本、层间身份、截止时间和指标」 | 单体 ×2、行级安全、主库和副本同机；回退原因全是连接池满（replica_saturated），因副本落后回退 0 次 |
| 截止时间的熔断缺陷，修复前后 | 修复前 234 次运行中 226 次直接 503；修复后 234 次全部 504（deadline_exceeded），0 次 503，失败延迟 p50 309 / 322 ms | CURRENT-TRUTH.md 3.20 | 截止时间 300 ms，假模型 800 ms，并发 4 / 16，默认熔断配置 |
| 异步入库 | 从提交到入库完成 p50：同步 1,320 ms，异步 930–947 ms；独立 worker 35.1 篇/秒，同步 24.9 篇/秒；上传请求从约 257 ms 变成几毫秒的 202 | CURRENT-TRUTH.md 3.15；docs/evaluation.md「多实例与异步入库」 | 2 个 API 实例、64 篇文档、并行度 8、embedding 200 ms、重复 3 次；同步与进程内异步（23.2）的吞吐区间重叠，不排序 |
| 跨文档 embedding 合批 | 并发上限为 2 时 41.7 对 19.6 篇/秒（2.1 倍），64 篇文档的请求 26–30 次对 64 次；上限 8 时无差别（64.8 对 65.2，区间重叠） | CURRENT-TRUTH.md 3.16；docs/evaluation.md「索引切换与入库流水线」 | 2 个独立 worker × 8 路、embedding 200 ms/请求、3 次重复；假模型按请求固定计时，偏向合批，这个倍数是上限；第一版在上限不卡时慢了 24%（审查发现），改成先占槽再合批 |
| 指标采集的开销 | 每请求 CPU：关 12.4–12.6 ms，开 12.4–12.8 ms；不下结论 | CURRENT-TRUTH.md 3.20 | 并发 16 时第一次测得开比关低约 1.5%，但复测的关与开区间重叠 |
| 代码中的默认值 | 模型在途上限 8；连续 5 次不可用熔断 30 s；请求超时 120 s；最多重试 3 次，退避基数 500 ms、上限 4 s，Retry-After 超过 10 s 放弃；token TTL 60 s、时钟偏差 5 s；副本不健康冷却 5 s；防重放缓存 10 万条；每个指标族 1000 组标签；停机排空 25 s、worker 宽限 5 s、余量 3 s，compose 30 s；AGENT_SERVICE_TIMEOUT_MS 300 s | server/rag/config.js getLlmMaxConcurrency / getLlmRequestTimeoutMs / getLlmCircuitFailureThreshold / getLlmCircuitCooldownMs（以及 SERVICE_SHUTDOWN_GRACE_MS、AGENT_SERVICE_TIMEOUT_MS 的 readRoleSettingMs 默认值）；server/rag/openai.js MAX_RETRIES / BACKOFF_BASE_MS / BACKOFF_CAP_MS / MAX_RETRY_AFTER_MS；server/rag/service-identity.js DEFAULT_SERVICE_TOKEN_TTL_MS / DEFAULT_SERVICE_TOKEN_CLOCK_SKEW_MS；server/rag/service-client.js DEFAULT_SERVICE_COOLDOWN_MS；server/rag/service-token-replay.js DEFAULT_SERVICE_REPLAY_CACHE_MAX_ENTRIES；server/rag/metrics.js DEFAULT_MAX_SERIES_PER_METRIC；server/server.js INGEST_WORKER_STOP_GRACE_MS / SHUTDOWN_FINALIZER_MARGIN_MS；docker-compose.yml stop_grace_period | 都是可调的默认值，不是按真实流量校准的 |

## 要主动说出口的边界

- 拆分部署只在一台机器上测过；同机、同进程数下单体快 1.56 倍；没有 K8s、服务发现和自动扩缩，副本列表写在环境变量里，增减副本要重启调用方
- compose.services.yml 只用 docker compose config 校验过解析，从没构建和启动过；用 --scale 扩容时多个容器共用一个 DNS 名，客户端的最少在途和故障转移都不生效
- 层间身份不是 mTLS，层间也没有加密；默认 hmac 下 issuer 是自报的，防重放默认关闭（60 s 内同一个请求可以原样重放）；防重放缓存按进程有上限，Redis 出错时以本副本的判定为准
- ed25519 只在四个进程的测试里跑通过，那次检索层用的是 local 向量库，没在 Docker 或 PostgreSQL 的检索层上跑过；老的几组拆分测试只在 hmac 下通过
- 所有层共用一个 PostgreSQL，它是共享瓶颈也是单点；PDF 字节存在任务表里
- 没有 Redis 时，网关的配额、并发上限和熔断都按进程计算，多个副本时总量会超出设定值；跨实例的公平只是近似
- 模型并发上限按在途请求数算，不是按 TPM；不会根据 429 自适应（没做 AIMD）；排队等待没有单独超时，只靠请求截止时间的 signal 出队；连续失败阈值在高错误率下可能误熔断
- 检索层没有并发上限，也没有准入控制
- 读副本让主库语句减少 28.8%，没达到事先定的 30%，吞吐也没变快；副本和主库同机，CI 里没有副本；副本上的语句只有连接超时；不检查副本是否真的在跟随这个主库；暂停回放的集成测试只覆盖两个单体实例
- 截止时间：数据库语句不取消；调用方断开不会让检索层停下；已经开始的写入型 Capability 会跑完；v3 统一图里非主节点的依赖故障仍返回 409；断开即取消默认关闭
- 告警规则从未在真实 Prometheus 或 promtool 里加载过；compose 没打开 METRICS；99.5% 和 20 s 的 SLO 目标是建议值；指标开销测了但不下结论
- 压测全用假模型，规划器是确定性的；生产默认的 LLM 规划器每个请求要多 2 次模型调用，「容量约为三分之一」只是推算，没有实测；压测器、应用和数据库都在同一台机器上
- claim memo 的 2.6 倍是在假模型、短回答下测的，真实模型下的加速比没测；CURRENT-TRUTH 3.15 里「约 90 req/s、每请求 12–13 ms」是 memo 之前的数
- 异步入库：拆分模式下的入库压测没做；同步和进程内异步的吞吐区间重叠，不能排序
- MCP server 是 stdio、只读、进程内快照（要调 archive_refresh 才能刷新），不经过 agent 规划器；租户范围只来自启动时的环境变量（ARCHIVE_MCP_USER_ID / ARCHIVE_MCP_WORKSPACE_ID），不按请求鉴权
- 没有生产流量，也没有真实的单次查询成本分布；所有模型侧的数字都来自本地假服务或本地 7B 模型

## 只能当推理讲的内容

核验代理找不到代码或数据依据的条目。讲的时候用「我的判断是……，没测过」。

- 「高频 NOTIFY 在提交时会串行化」是 PostgreSQL 的通用知识，项目文档和代码里没有测过；已改成「开销需要压测验证」，属于推断
- 「租户设置用 set_config(..., true) 事务内生效，所以理论上兼容 PgBouncer 事务模式」是推断，没有测试或文档；已在 trap 里标成需要验证
- 「least-outstanding 对慢请求长尾比轮询稳」是设计理由，项目里没有拆分模式下 least-outstanding 和 round-robin 的对照数字（docs/evaluation.md 只说 --balance 默认 least-outstanding，与 nginx least_conn 相同），不要报数字
- 100 倍规模、多机、K8s 相关的改法全是推断，没有任何实测
- 「Phoenix 只收 protobuf」的出处是 INTERVIEW-FAQ #17 和 AGENTS.md（"Phoenix rejects JSON"），本次没有在 Phoenix 上复核；已改写成「Phoenix 的 OTLP/HTTP 不收 JSON」，与这两个出处一致

## 容易记错的地方

第一遍阅读（主要依据 AGENTS.md 和文档）写错、被核验代理对照代码改正的说法。这些正是读文档容易产生的误解。

- **requestFlow 第 4 步**
  - 原以为：routes/chat.js：runAgentRequestWithCancellation → runWithAgentEventSink → runAgentRag
  - 实际：runAgentRequestWithCancellation → runWithAgentEventSink → buildChatResponse（app-services.js，先刷新注册表，再调 runAgentRag）
  - 依据：server/routes/chat.js 第 123、148、230 行调用的是 services.buildChatResponse；app-services.js 第 215 行 export const buildChatResponse
- **requestFlow 第 7 步 + 负载均衡题 answerPoints + edge-router keyFile**
  - 原以为：上游中断时补 error（SERVICE_STREAM_INTERRUPTED 或 504）
  - 实际：error 帧 code 为 SERVICE_STREAM_INTERRUPTED（status 502），超时时 code 为 SERVICE_TIMEOUT（status 504），再补 done
  - 依据：server/rag/agent-service/edge-router.js 第 409–423 行：timedOut ? "SERVICE_TIMEOUT" : streamInterrupted，status: timedOut ? 504 : 502
- **入库 claim 的写法（requestFlow 异步上传、入库题 answerPoints）**
  - 原以为：claim 是一条 UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)
  - 实际：WITH candidate AS (SELECT ... ORDER BY 相关子查询(该租户在跑任务数), created_at LIMIT 1 FOR UPDATE OF c SKIP LOCKED) UPDATE ...；候选也包括租约已过期、stage_attempts 未用尽的 running 任务
  - 依据：server/rag/ingest-job-store.js 第 1079–1107 行的 SQL
- **熔断决策 + 熔断题**
  - 原以为：429、其他 4xx 和空响应不计入
  - 实际：429 和其他 4xx 不算失败，guard 对它们调用 breaker.recordSuccess（连续失败计数清零）；空响应在 guard 层是正常返回。另加 trap：429 与 503 交替时会推迟熔断
  - 依据：server/rag/model-call-guard.js guardModelCall 第 939–945 行：isCallerCancellation → abandon，isUnavailableError → recordFailure，否则 recordSuccess；createCircuitBreaker.recordSuccess 第 554–560 行把 consecutiveFailures 置 0
- **拆分代价（decision 1 tradeoff、电梯讲稿、层级 2 题、numbers）**
  - 原以为：每多一跳 p50 +4.3 ms
  - 实际：拆成四层（4 个进程）相对单体（1 个进程），并发 1 时 p50 +4.3 ms，是整体差值，不是每一跳
  - 依据：CURRENT-TRUTH 3.19 原文：「每多一跳的代价（拆成 4 个进程对单体 1 个进程，并发 1、模型延迟 0）：p50 12.7 → 17.0 ms（+4.3）」；docs/evaluation.md 拆分表「拆分 1/1/1/1 | 4 | 并发 1 时 p50 17.0 ms（+4.3）」
- **MCP server（keyFiles、层级 1 题、limitations）**
  - 原以为：archive_ask / list_documents / refresh；没有网络鉴权
  - 实际：工具名是 archive_ask / archive_list_documents / archive_refresh；租户范围只来自 ARCHIVE_MCP_USER_ID / ARCHIVE_MCP_WORKSPACE_ID，多租户配置下没有它们会以 ARCHIVE_MCP_SCOPE_REQUIRED 拒绝启动
  - 依据：server/archive-mcp-server.js 第 57–71 行；server/archive-mcp-tools.js 第 17、55 行
- **decision 1**
  - 原以为：多了一个空字段 "alternatesRejected": ""
  - 实际：删除该字段，只保留 alternativesRejected
  - 依据：schema 只定义 alternativesRejected
- **embedding 合批决策和 numbers**
  - 原以为：证据只写了 64.8 对 65.2、41.7 对 19.6、第一版慢 24%
  - 实际：补上前提：2 个独立 worker × 8 路、embedding 200 ms/请求、3 次重复，上限 8 时无差别；假模型按请求固定计时，偏向合批，2.1 倍是上限；第一版慢 24% 是审查发现的
  - 依据：docs/evaluation.md「索引切换与入库流水线」：「假模型按请求固定计时，偏向合批，这个倍数是上限」；CURRENT-TRUTH 3.16：「第一版合批在上限不卡时反而慢 24%，被审查发现」
- **截止时间题 answerPoints**
  - 原以为：客户端离开 → 499，运行标为 canceled
  - 实际：补上前提：需要 AGENT_CANCEL_ON_DISCONNECT=on（默认关）
  - 依据：server/rag/request-deadline.js 第 305–309 行；AGENTS.md「AGENT_CANCEL_ON_DISCONNECT=on (default off) also cancels when the client disconnects」
- **可观测性决策 alternativesRejected + 可观测性题**
  - 原以为：LangSmith 或 Langfuse SDK：会把 prompt 和文档发给第三方
  - 实际：LangSmith 追踪会把 prompt 和输出上报到 LangSmith 服务，项目禁止；Langfuse 可自托管，也能经 OTLP 接本项目的 span，不用它的 SDK 是为了不绑厂商、不默认记录内容
  - 依据：把 Langfuse 一概说成「发给第三方」是夸大；FAQ #17 和 AGENTS.md 都写了 Phoenix、Langfuse、Jaeger 可经 OTLP 接入
- **性能证明题 + memo 数字 caveat**
  - 原以为：claim 检查 memo，每请求 CPU 从 12–13 ms 降到约 5 ms
  - 实际：补上：改动还包含数字快速路径（normalizeUnicodeDecimalDigits），约省 0.3–1 ms，大部分来自 memo
  - 依据：docs/evaluation.md「Claim 检查 memo」：「拆开看……大部分（约 12.8 → 5–7 ms）来自 memo，快速路径再省约 0.3–1 ms」
- **往返优化的 PG CPU（decision evidence、numbers）**
  - 原以为：PG CPU 每请求 7.7 → 4.0 ms（没说是哪一档）
  - 实际：7.7 → 4.0 ms 是租户 4 实例那一档；租户单实例是 6.0 → 2.9 ms
  - 依据：docs/evaluation.md「每次 /chat 的数据库往返」吞吐表
- **共享状态决策 tradeoff**
  - 原以为：等待方每秒要执行几百次获取脚本
  - 实际：4 实例、并发 64、模型 800 ms 时，等待方约 359 次获取脚本/秒（每个槽位 36 次），按等待时长计
  - 依据：docs/evaluation.md「多实例与异步入库」第 1881 行
- **numbers「Redis 共享后整个集群在途数严格等于 8」**
  - 原以为：caveat 只写了假模型 800 ms
  - 实际：补上 4 实例、并发 64，以及不共享时 39.9 req/s
  - 依据：docs/evaluation.md「多实例与异步入库」
- **numbers「代码中的默认值」source**
  - 原以为：source 缺退避上限、时钟偏差、熔断阈值、冷却时间和 worker 宽限的出处
  - 实际：补上 BACKOFF_CAP_MS、DEFAULT_SERVICE_TOKEN_CLOCK_SKEW_MS、getLlmCircuitFailureThreshold / getLlmCircuitCooldownMs、INGEST_WORKER_STOP_GRACE_MS、readRoleSettingMs 默认值（SERVICE_SHUTDOWN_GRACE_MS 25_000、AGENT_SERVICE_TIMEOUT_MS 300_000）、compose stop_grace_period
  - 依据：server/rag/openai.js 第 45 行 BACKOFF_CAP_MS = 4000；service-identity.js 第 81 行；config.js 第 328–332、2512、2522 行；server.js 第 85 行；docker-compose.yml 第 72 行
- **入库百倍题 codeRefs**
  - 原以为：server/db/migrations/015_create_rag_ingest_jobs.sql claim_idx
  - 实际：__INGEST_JOBS_TABLE___claim_idx（模板化的表名）
  - 依据：015_create_rag_ingest_jobs.sql 第 37 行 CREATE INDEX IF NOT EXISTS __INGEST_JOBS_TABLE___claim_idx
- **性能证明题 codeRefs**
  - 原以为：server/rag/postgres-agent-run-store.js、server/rag/self-check/evidence-context.js（没写函数名）
  - 实际：postgres-agent-run-store.js createPostgresAgentRunStore；evidence-context.js createSelfCheckEvidenceContext
  - 依据：grep：postgres-agent-run-store.js 第 338 行、evidence-context.js 第 31 行
- **读副本决策 tradeoff 与 trap、limitations**
  - 原以为：没提集成测试覆盖范围
  - 实际：补上：暂停回放的集成测试只覆盖两个单体实例，拆分拓扑没测
  - 依据：docs/evaluation.md「读副本、层间身份……」：「只覆盖两个单体实例，拆分拓扑在暂停重放下没有集成测试」
- **LLM 重试决策**
  - 原以为：没列出可重试状态码
  - 实际：补上可重试状态码 408/409/429/500/502/503/504
  - 依据：server/rag/openai.js isRetriableError 第 104 行
- **电梯讲稿**
  - 原以为：主模型宕机从 0 到 100%；数据库往返从 167 降到 22
  - 实际：主模型宕机 0 → 100%（前提是配了备用模型）；租户路径 167 → 22
  - 依据：CURRENT-TRUTH 3.4「改后、无备用模型」列为 0%；docs/evaluation.md 往返表的租户 / owner 两列
- **staleInExistingDocs 最后一条**
  - 原以为：只引用了 AGENTS.md 和 docs/deployment.md，并写「讲之前要确认每条调用路径都传了 signal」
  - 实际：补上 docs/configuration.md 第 654 行的同类说法；确认 guardModelCall 把 signal 传给 limiter.acquire，sendToUpstream 和 upstream-pool 也传了；git 显示 signal 出队是 eb5650ea 加的，晚于 d8c1e01f
  - 依据：model-call-guard.js 第 369–382、911 行；openai-client.js 第 30–39 行；upstream-pool.js 第 155 行；git log -S toAbortReason / -S 'does not observe the signal'
- **limitations**
  - 原以为：缺两条限制
  - 实际：新增「检索层没有并发上限和准入控制」「guard 排队没有单独超时，只靠截止时间的 signal 出队」
  - 依据：docs/deployment.md 第 323 行；docs/evaluation.md「并发上限与熔断」边界：「排队等待没有单独的超时」
