# 部署

## 一键部署（Docker Compose）

```bash
docker compose --profile app up -d --build
```

- 启动 `app`（API + 前端，一个镜像）和 `postgres`（PostgreSQL 16 + pgvector）。
- 浏览器打开 http://localhost:5001：前端由 API 服务直接托管，页面按同源地址调用 API。
- 数据位置：
  - 文档、分块、向量、运行记录在 PostgreSQL 的 `pgdata` 卷里；
  - 上传的原始文件和本地数据在 `appdata` 卷里（容器内 `/data`）。
- 数据库迁移在启动时自动执行。`docker compose ps` 里 `app` 显示 `healthy` 即表示 `/health` 返回正常。

### 模型配置

`server/.env` 存在时会整个读进容器，模型地址和 key 都写在那里，写法和本地开发一样。数据库地址由 compose 覆盖，指向 `postgres` 服务，不用改。

用宿主机上的 Ollama：

```bash
OPENAI_BASE_URL=http://host.docker.internal:11434/v1
OPENAI_API_KEY=ollama
OPENAI_CHAT_MODEL=qwen2.5:7b
OPENAI_EMBEDDING_MODEL=nomic-embed-text
RAG_EMBEDDING_DIMENSIONS=768
```

### 版面解析（可选）

```bash
PDF_PARSER=docling docker compose --profile app --profile layout up -d
```

- 另起一个 `docling` 服务：docling-serve CPU 版，压缩后约 2 GB，自带模型；
- 应用会把 PDF 交给它解析。它能按多栏的阅读顺序输出正文，并把表格还原成带列名的行；
- 服务不可用时退回 pdf.js，并在 `/health` 的 `checks.pdfParser` 里报错；
- 效果和代价见 [evaluation.md](evaluation.md) 的"版面解析"。

### 交叉编码器重排（可选，推荐）

```bash
docker compose -f docker-compose.yml -f compose.rerank.yml --profile app --profile rerank up -d --build
```

- **会多起一个 `reranker` 服务，配置和评测时完全一致：**
  - 服务脚本：`server/evaluation/neural-cross-encoder-endpoint.py`；
  - 依赖：`server/evaluation/neural-reranker-requirements.txt` 里固定的版本；
  - 模型：`BAAI/bge-reranker-v2-m3`，max_length 384，batch 8（都是脚本的默认值，评测时没有改）；
  - 返回原始 logits。
- **镜像**：由 `server/evaluation/cross-encoder-service/Dockerfile` 构建，基础镜像是 python:3.14-slim，torch 装 CPU 版。`Dockerfile.dockerignore` 只把脚本和依赖文件放进构建上下文，模型缓存和评测数据不会被发送。**这个镜像还没有实际构建过**：如果 PyTorch 的 CPU 源上没有对应的 torch wheel，第一次构建会在 pip 这一步失败。这时加 `--build-arg TORCH_INDEX_URL=https://pypi.org/simple` 再构建。
- **`compose.rerank.yml` 做什么**：给 `app` 设置下面这几项，并等 `reranker` 的健康检查通过后再启动 `app`：

  ```bash
  RAG_RERANK_ENABLED=true
  RAG_RERANK_PROVIDER=cross-encoder
  RAG_CROSS_ENCODER_ENDPOINT=http://reranker:8081/rerank
  RAG_CROSS_ENCODER_MODEL=BAAI/bge-reranker-v2-m3
  RAG_CROSS_ENCODER_SCORES=logits
  ```

  这些设置单独放一个文件，是因为 compose 的 `environment` 会覆盖 `server/.env`。部署时不带这个文件，`server/.env` 里的重排设置就照常生效。
- **两个参数都要带**：只加 `-f compose.rerank.yml`、不加 `--profile rerank`，compose 会报 `service "app" depends on undefined service "reranker"`。
- **其余重排参数读 `server/.env`**，没写就用代码默认值。评测时的取值就是默认值：
  - `RAG_RERANK_WEIGHT=0.6`
  - `RAG_RERANK_CANDIDATE_MULTIPLIER=3`
  - `RAG_QA_MIN_RERANK_PROBABILITY=0.02`
- **模型缓存**：挂载 `server/evaluation/generated/huggingface`，和本机 `npm run rerank:cross-encoder` 共用一个目录，本机下载过的模型不会再下载。新机器第一次启动要下载约 2.3 GB，下载完才开始监听。健康检查留了 30 分钟的启动时间，这段时间里 `up` 会一直等。
- **速度**：
  - 容器里只能用 CPU。评测里"18 个候选约 0.4 秒"是在 Apple MPS 上测的。
  - 同一台 Apple M5 Pro 不进容器、只用 CPU 时，18 个候选约 2.8 秒（英文）到 4.5 秒（900 字的中文分块）。
  - 服务逐个处理请求。Docker Desktop 虚拟机分到的 CPU 一般更少，会更慢。
  - 超时默认 `RAG_CROSS_ENCODER_TIMEOUT_MS=30000`，不够时在 `server/.env` 里调大。超时或服务不可用时查询不会失败，只是这次不重排。
- **拒答门控**：开启重排后，"要不要回答"改由重排模型的相关概率决定（`RAG_QA_MIN_RERANK_PROBABILITY=0.02`）。拒答少得多，但也会有更多不可回答的问题被答出来。想保留原来更严的词面门控，设为 `off`。
- **不用 Docker**：先 `npm run rerank:cross-encoder:setup`，再 `RAG_CROSS_ENCODER_MODEL=BAAI/bge-reranker-v2-m3 npm run rerank:cross-encoder`。有 CUDA 或 MPS 时会用 GPU。
- **只起重排服务、给本机评测用**：`cd server && npm run rerank:cross-encoder:docker`。用同一个镜像，监听 `127.0.0.1:8081`。
- **换成 Hugging Face TEI**：`/rerank` 接口格式相同，但 TEI 默认返回概率，要同时设 `RAG_CROSS_ENCODER_SCORES=probabilities`，否则拒答门控会按错误的分数判断。

### 多实例共享状态（可选）

```bash
RAG_SHARED_STATE=redis docker compose --profile app --profile shared-state up -d
```

### 异步入库（可选）

```bash
RAG_INGEST_MODE=async docker compose --profile app up -d
```

- 上传在校验后立即返回 202，解析、向量化和写索引由 worker 完成。默认每个 API 进程同时运行 worker（每进程 2 个任务）。
- 把入库放到单独的进程：API 进程设 `RAG_INGEST_WORKER_ENABLED=false`，另外运行一个或多个 `cd server && npm run worker:ingest`，环境变量和 API 相同（数据库、模型、`PDF_PARSER`、上传目录），只跑 worker、不监听端口。多个 worker 通过 `SKIP LOCKED` 领取任务，同一个任务不会同时交给两个 worker。
- 跨进程入库需要共享的向量库（pgvector 或 qdrant）。`VECTOR_STORE_PROVIDER=local` 的索引在每个进程自己的内存和文件里：独立 worker 拒绝启动，API 进程忽略 `RAG_INGEST_WORKER_ENABLED=false`、在本进程运行 worker 并打印错误。没有 PostgreSQL 时队列在 API 进程内存里，同样只由本进程处理。
- 每个运行 worker 的进程额外保持一个不走连接池的 PostgreSQL 连接，用来 `LISTEN` 新任务的通知，算连接数时要算上。它必须直连数据库或经过会话池：PgBouncer 事务池下收不到 `NOTIFY`，worker 退回每 `RAG_INGEST_WORKER_POLL_MS` 轮询一次。
- 多实例部署时，每个实例按请求租户从 PostgreSQL 重读文档注册表（`GET /documents`、每个 `/chat` 开头、arXiv 查重），删除前按 id 重读，所以别的实例上传或删除的文档在这里立即可见；代价是每个 `/chat` 多一次按租户列出文档的查询。这对 `sync` 和 `async` 都成立。
- 停机：收到 SIGTERM 或 SIGINT 后停止领取新任务，给运行中的任务 5 秒；没完成的归还队列（不计入尝试次数），其他 worker 可以立即接手。进程被强制结束时，任务在租约过期后由其他 worker 重试。
- 从 `async` 切回 `sync` 前先等队列清空：`sync` 下 API 进程不运行 worker，剩下的任务要靠 `npm run worker:ingest`。

### 其他说明

- 镜像构建时把 `VITE_DOMAIN` 设成 `same-origin`。构建参数 `VITE_API_AUTH_TOKEN` 会打进前端包、发给每个浏览器，只适合单个可信用户。多用户部署用 `API_AUTH_TOKENS`，由前端之外的方式分发 token。
- 镜像以非 root 用户 `node` 运行，只有 `/data` 可写。
- 镜像里的 npm 10 在安装服务端依赖时会要求 `@qdrant/js-client-rest` 的 peer 依赖 typescript。本机 npm 11 生成的锁文件里没有它，而运行时也用不到，所以 Dockerfile 用 `--legacy-peer-deps` 安装。

## 拆分部署（可选）

默认仍是一个进程：不设 `ARCHIVE_RAG_ROLE`、不设服务地址时，`node server.js` 和上面的一键部署都和原来完全一样。拆分是可选的，用来让某一层单独加副本。

### 分几层

同一个镜像、同一个入口 `node server.js`，用 `ARCHIVE_RAG_ROLE` 选角色：

| 角色 | 默认端口 | 做什么 | 调用谁（设了对应地址时） |
| --- | --- | --- | --- |
| `api` | `PORT`，否则 5001 | 公网入口：鉴权、限流、CORS、前端静态文件、上传、文档、入库任务（包括进程内的入库 worker）、管理接口。`/chat`、`/chat/stream`、任务、agent run 及其操作、管理动作转发给 agent 层。不跑 Agent，也不做启动恢复。 | agent 层；入库的 embedding 走模型网关 |
| `agent` | `PORT`，否则 5001 | Agent 编排：`runAgentRag`、后台任务、启动恢复、公网入口转来的管理动作。只接受内部签名身份。 | 检索层、模型网关 |
| `retrieval` | `PORT`，否则 5002 | 按调用方的租户（行级安全）做查询 embedding、稠密 + 稀疏检索、融合、重排。只接受内部签名身份。 | 模型网关 |
| `model-gateway` | `MODEL_GATEWAY_PORT`，否则 `PORT`，否则 5003 | OpenAI 兼容的模型服务：重试、退避、切换备用模型、并发上限、熔断、用量计量、按 workspace 的配额，并在多个上游副本之间分配请求。 | chat、embedding、重排的上游 |

- `retrieval` 和 `model-gateway` 也有单独的入口：`node retrieval-service.mjs`、`node model-gateway.mjs`。两种启动方式做同样的启动检查；用 `node server.js` 启动时，停机有 `SERVICE_SHUTDOWN_GRACE_MS` 的上限，单独入口没有。
- 每个角色都有 `GET /livez`（只说明进程在）、`GET /health` 和 `GET /ready`，都不需要身份。api 的 `/health` 多两项：`checks.serviceTopology`，以及逐个探测 agent 副本的 `checks.agentService`。agent 层不可达时这一项是 `warning`，不会让 `/ready` 变成 503，所以公网入口留在负载均衡里，文档和上传照常可用，Agent 相关接口返回 503。
- 模型网关的 `GET /health` 列出每个上游副本的在途数、熔断状态和配额设置；`GET /usage` 按租户列出用量，只接受系统身份、带 `admin` claim 或带 `admin.status.read` 权限的内部 token，不对公网开放。

### 前提

- **一个 PostgreSQL**：所有层用同一个 `POSTGRES_DATABASE_URL`。文档、分块、运行记录、任务、审计和入库队列都在里面，公网入口上传的文档靠它对检索层可见。内存存储不能跨层使用，拓扑检查不会发现这种配置。
- **共享的向量库**：`pgvector`（默认）或 `qdrant`。检索层拒绝 `VECTOR_STORE_PROVIDER=local` 和 standalone 模式。
- **同一份密钥**：所有层设同一个 `INTERNAL_SERVICE_KEYS`。生成一个：

  ```bash
  node -e "console.log('k1:' + require('crypto').randomBytes(32).toString('base64url'))"
  ```

- **同一份其余配置**：模型、`RAG_*`、embedding 前缀、查询适配器文件等在各层保持一致，目前没有自动检查。模型的 key 只需要给网关；其他层在设了 `MODEL_GATEWAY_URL` 后不再直接调用模型（例外见下面的"限制"）。
- 启动时先校验拓扑：角色未知、地址无效、`api` 没有 `AGENT_SERVICE_URL`、缺少可用密钥，都会拒绝启动，报错里没有密钥。

### 在一台机器上跑起来

```bash
cd server
export INTERNAL_SERVICE_KEYS="<上面打印的整行，形如 k1:...>"
export AGENT_SERVICE_URL=http://127.0.0.1:5101
export RETRIEVAL_SERVICE_URL=http://127.0.0.1:5002
export MODEL_GATEWAY_URL=http://127.0.0.1:5003

ARCHIVE_RAG_ROLE=model-gateway PORT=5003 node server.js &
ARCHIVE_RAG_ROLE=retrieval     PORT=5002 node server.js &
ARCHIVE_RAG_ROLE=agent         PORT=5101 node server.js &
ARCHIVE_RAG_ROLE=api           PORT=5001 node server.js
```

- 四个进程用同一份环境变量。每一层都会忽略指向自己的地址，模型网关还会忽略 agent 和检索层的地址（启动时各打印一条警告），所以不用为每个角色单独准备一份。
- `server/.env` 照常读取；上面的 `export` 优先。`PORT` 写明比依赖默认值稳妥：`server/.env` 里如果设了 `PORT`，所有角色都会用它。
- 只拆一部分也可以：只设 `MODEL_GATEWAY_URL`、不设角色，就是"单体 + 独立模型网关"；`agent` 不设 `RETRIEVAL_SERVICE_URL` 时在本进程检索。
- 开 OpenTelemetry 时给每个角色设不同的 `OTEL_SERVICE_NAME`，否则在 trace 后端里它们是同一个服务名。

### 给某一层加副本

- **agent 或检索层**：在另一个端口（或另一台机器）再起一个同角色的进程，然后把它加进调用方的地址列表，例如 `AGENT_SERVICE_URL=http://127.0.0.1:5101,http://127.0.0.1:5102`，再重启调用方。没有服务发现，副本列表只从环境变量读。
- **模型网关**：同样起多个网关进程，列进 `MODEL_GATEWAY_URL`。多个网关副本要共享并发上限、熔断和配额计数，设 `RAG_SHARED_STATE=redis`；不设时每个网关进程各算各的。
- **推理后端（embedding、重排）**：在网关上列多个上游，例如 `MODEL_GATEWAY_EMBEDDING_UPSTREAMS=http://gpu-a:11434/v1,http://gpu-b:11434/v1`、`MODEL_GATEWAY_RERANK_UPSTREAMS=http://r1:8081/rerank,http://r2:8081/rerank`。网关选进行中请求最少的健康副本，每个副本有自己的并发上限和熔断；连接被拒或熔断打开时立即换下一个副本。
- **入库**：仍在 api 层（或 `npm run worker:ingest` 独立 worker）执行，扩法见上面的"异步入库"。worker 设了 `MODEL_GATEWAY_URL` 时 embedding 也走网关，同样需要 `INTERNAL_SERVICE_KEYS`。
- 调用方怎么选副本：进行中请求最少的优先；连不上或返回 502/503/504 的副本在 `INTERNAL_SERVICE_UNHEALTHY_COOLDOWN_MS` 内被跳过。已经发出的 `/chat` 和任务操作不会重发到另一个副本。

### 用镜像部署

- 同一个镜像，给每个容器设不同的 `ARCHIVE_RAG_ROLE`，`CMD` 不用改。镜像里预设了 `PORT=5001`，所以每个角色在自己的容器里都监听 5001，镜像的健康检查也探测这个端口；不要单独给网关设 `MODEL_GATEWAY_PORT`，否则健康检查会探错端口。
- 只有 api 容器需要对外发布端口；其他层放在内部网络，服务地址写容器名，例如 `AGENT_SERVICE_URL=http://agent:5001`。
- `compose.services.yml` 把四个角色作为四个服务跑，用同一个镜像，只有 api 发布端口：

  ```bash
  export INTERNAL_SERVICE_KEYS="k1:<32 个字符以上的密钥>"
  docker compose -f docker-compose.yml -f compose.services.yml up -d --build --scale agent=2
  ```

  - `INTERNAL_SERVICE_KEYS` 必须从 shell 提供，文件里没有默认值，不设就拒绝启动。
  - 它是追加在基础文件上的 override，不能和 `--profile app` 同时用（两者都占 5001）。多个 api 副本要把 `ARCHIVE_RAG_API_PORTS` 设成端口范围（例如 `5001-5003`），或者自己在前面放负载均衡。
  - `--scale` 起的副本共用一个 DNS 名（例如 `http://agent:5001`），service client 把它当成一个副本，负载靠 Docker DNS 在建连时分散。要用按副本的最少在途选择和故障转移，得在地址里逐个列出副本。
  - 这个文件还没有真正构建和启动过，只用 `docker compose config` 校验过解析，由 `test/deployment-contract.test.mjs` 固定。
- 仓库里没有 Kubernetes 清单。

### 换内部密钥

第一个密钥签名，所有密钥都能验证。逐个重启期间，新旧配置的进程同时在跑，所以分三轮：

1. 把新密钥加到最后：`INTERNAL_SERVICE_KEYS=k1:<旧>,k2:<新>`，逐个重启所有层。这时仍用 `k1` 签名，`k2` 只用于验证。
2. 所有层都换完后，把新密钥挪到最前面：`k2:<新>,k1:<旧>`，再逐个重启。这时用 `k2` 签名，还没重启的进程也认得它。
3. 最后删掉 `k1`，再逐个重启一次。

如果第一步就把新密钥放在最前面，先重启的进程会用 `k2` 签名，还没重启的进程不认识它，这些调用会被拒绝（公网入口转发 Agent 请求时返回 502 `SERVICE_IDENTITY_REJECTED`）。

### 限制

- 只在一台机器上跑过，没有多机、Kubernetes 清单、服务发现或自动扩缩；副本列表写在环境变量里，增减副本要重启调用方。
- 所有层共用一个 PostgreSQL，它既是共享瓶颈，也是单点。
- 层间身份是共享密钥的 HMAC（HS256），不是 mTLS：每一层都握有同一组密钥，能以任何 issuer 签名；token 在有效期（默认 60 秒）内可重放，不绑定路径。内部端口必须只在内网可达，层间 TLS 要自己在前面加。
- 没有 Redis 时，网关的配额、并发上限和熔断都按网关进程计算，多个网关副本时总量会超出设定值。
- 公网入口超时（`AGENT_SERVICE_TIMEOUT_MS`）后，agent 层上的运行会继续跑完，不会被取消；agent 层也不按截止时间限制运行。检索层到截止时间只提前返回 504，检索本身不取消；检索层没有并发上限或准入控制。
- agent 层因为下游故障返回的 503（例如模型熔断）也会让入口把这个 agent 副本当作不健康，跳过 5 秒。
- 检索层或模型网关停掉时，`/chat` 不返回 503，而是和单体里模型或数据库故障时一样：`document_rag` 步骤记为失败，Agent 转去请求 Web 搜索审批，返回 200 的 clarification。只有 agent 层本身不可达时，入口才返回 503。
- 各层的 `/health` 不需要认证，会列出内部副本地址和密钥 id（不含密钥本身）；api 的 `/health` 每次都会探测每个 agent 副本。
- 拆分模式下检索请求有上限（`RETRIEVAL_SERVICE_MAX_*`），超长问题或配得过大的 topK 返回 400，单体没有这些限制。

## CI 里的真实模型评测

`.github/workflows/real-model-eval.yml`：每周一定时跑，也可以手动触发，手动时可以指定对话模型，以及 QASPER 答题的题数。

- 在 GitHub 的 CPU 机器上装 Ollama，拉取 `nomic-embed-text` 和对话模型（默认 `qwen2.5:7b`）。模型有缓存，不需要任何 API key。
- 三步评测：
  1. `verify:quality`：18 项端到端检查，任何一项阻断失败，整个 job 就失败；
  2. QASPER dev 抽样 200 题，测证据能否进入问答候选；召回低于 0.6 就失败（设定下限时实测为 0.655）；
  3. QASPER dev 答题，默认 40 题，只出报告，不设门槛。CPU 上 7B 模型大约一分钟答一题。
- 报告作为 `real-model-eval` artifact 上传；前面的步骤失败也会上传。
- 首次运行（2026-09-26）约 63 分钟通过：`verify:quality` 18/18，召回 0.655，和本机结果一致。
