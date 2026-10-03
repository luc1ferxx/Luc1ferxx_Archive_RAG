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
- 每个角色都有 `GET /livez`（只说明进程在）、`GET /health` 和 `GET /ready`，都不需要身份；设了 `METRICS_ENABLED=true` 时，每个角色还在单独的端口上提供 `/metrics`（见下面的"指标与告警"）。api 的 `/health` 多两项：`checks.serviceTopology`，以及逐个探测 agent 副本的 `checks.agentService`。agent 层不可达时这一项是 `warning`，不会让 `/ready` 变成 503，所以公网入口留在负载均衡里，文档和上传照常可用，Agent 相关接口返回 503。
- 模型网关的 `GET /health` 列出每个上游副本的在途数、熔断状态和配额设置；`GET /usage` 按租户列出用量，只接受系统身份、带 `admin` claim 或带 `admin.status.read` 权限的内部 token，不对公网开放。

### 前提

- **一个 PostgreSQL**：所有层用同一个 `POSTGRES_DATABASE_URL`。文档、分块、运行记录、任务、审计和入库队列都在里面，公网入口上传的文档靠它对检索层可见。内存存储不能跨层使用，拓扑检查不会发现这种配置。
- **共享的向量库**：`pgvector`（默认）或 `qdrant`。检索层拒绝 `VECTOR_STORE_PROVIDER=local` 和 standalone 模式。
- **内部身份**：二选一（`INTERNAL_SERVICE_AUTH`，详见下面的"内部身份与密钥"）：
  - `hmac`（默认）：所有层设同一个 `INTERNAL_SERVICE_KEYS`。生成一个：

    ```bash
    node -e "console.log('k1:' + require('crypto').randomBytes(32).toString('base64url'))"
    ```

  - `ed25519`：每个会调用别的层的进程有自己的私钥，所有层共享一份受信公钥列表。用 `node server/service-keys.mjs` 生成。

- **同一份其余配置**：模型、`RAG_*`、embedding 前缀、查询适配器文件等在各层保持一致，目前没有自动检查。模型的 key 只需要给网关；其他层在设了 `MODEL_GATEWAY_URL` 后不再直接调用模型（例外见下面的"限制"）。
- 启动时先校验拓扑：角色未知、地址无效、`api` 没有 `AGENT_SERVICE_URL`、缺少可用密钥（`ed25519` 下还包括缺私钥、被调用的层没有任何合法调用方的公钥、`INTERNAL_SERVICE_REQUEST_BINDING` / `INTERNAL_SERVICE_REPLAY_CACHE` 写了无法识别的值），都会拒绝启动，报错里没有密钥。

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

- 上面是默认的 `hmac`。改用 `ed25519` 时，把 `INTERNAL_SERVICE_KEYS` 换成 `INTERNAL_SERVICE_AUTH=ed25519` 和共享的 `INTERNAL_SERVICE_TRUSTED_KEYS`，再给 api、agent、retrieval 三个进程各自设自己的 `INTERNAL_SERVICE_SIGNING_KEY`（模型网关不调用别人，不需要私钥）；步骤见下面的"内部身份与密钥"。
- 四个进程用同一份环境变量（`ed25519` 下私钥除外）。每一层都会忽略指向自己的地址，模型网关还会忽略 agent 和检索层的地址（启动时各打印一条警告），所以不用为每个角色单独准备一份。
- `server/.env` 照常读取；上面的 `export` 优先。`PORT` 写明比依赖默认值稳妥：`server/.env` 里如果设了 `PORT`，所有角色都会用它。
- 只拆一部分也可以：只设 `MODEL_GATEWAY_URL`、不设角色，就是"单体 + 独立模型网关"；`agent` 不设 `RETRIEVAL_SERVICE_URL` 时在本进程检索。
- 开 OpenTelemetry 时给每个角色设不同的 `OTEL_SERVICE_NAME`，否则在 trace 后端里它们是同一个服务名。

### 给某一层加副本

- **agent 或检索层**：在另一个端口（或另一台机器）再起一个同角色的进程，然后把它加进调用方的地址列表，例如 `AGENT_SERVICE_URL=http://127.0.0.1:5101,http://127.0.0.1:5102`，再重启调用方。没有服务发现，副本列表只从环境变量读。
- **模型网关**：同样起多个网关进程，列进 `MODEL_GATEWAY_URL`。多个网关副本要共享并发上限、熔断和配额计数，设 `RAG_SHARED_STATE=redis`；不设时每个网关进程各算各的。
- **推理后端（embedding、重排）**：在网关上列多个上游，例如 `MODEL_GATEWAY_EMBEDDING_UPSTREAMS=http://gpu-a:11434/v1,http://gpu-b:11434/v1`、`MODEL_GATEWAY_RERANK_UPSTREAMS=http://r1:8081/rerank,http://r2:8081/rerank`。网关选进行中请求最少的健康副本，每个副本有自己的并发上限和熔断；连接被拒或熔断打开时立即换下一个副本。
- **入库**：仍在 api 层（或 `npm run worker:ingest` 独立 worker）执行，扩法见上面的"异步入库"。worker 设了 `MODEL_GATEWAY_URL` 时 embedding 也走网关，同样需要内部身份：`hmac` 下是 `INTERNAL_SERVICE_KEYS`；`ed25519` 下给 worker 单独一把私钥，并设 `INTERNAL_SERVICE_ISSUER=ingest-worker`、把它的公钥以 `ingest-worker` 登记进网关的 `INTERNAL_SERVICE_TRUSTED_KEYS`，这样按调用策略它只能调用网关。不设 `INTERNAL_SERVICE_ISSUER` 时 worker 以 `all` 签名。
- 调用方怎么选副本：进行中请求最少的优先；连不上或返回 502/503/504 的副本在 `INTERNAL_SERVICE_UNHEALTHY_COOLDOWN_MS` 内被跳过。已经发出的 `/chat` 和任务操作不会重发到另一个副本。

### 用镜像部署

- 同一个镜像，给每个容器设不同的 `ARCHIVE_RAG_ROLE`，`CMD` 不用改。镜像里预设了 `PORT=5001`，所以每个角色在自己的容器里都监听 5001，镜像的健康检查也探测这个端口；不要单独给网关设 `MODEL_GATEWAY_PORT`，否则健康检查会探错端口。
- 只有 api 容器需要对外发布端口；其他层放在内部网络，服务地址写容器名，例如 `AGENT_SERVICE_URL=http://agent:5001`。
- `compose.services.yml` 把四个角色作为四个服务跑，用同一个镜像，只有 api 发布端口：

  ```bash
  export INTERNAL_SERVICE_KEYS="k1:<32 个字符以上的密钥>"
  docker compose -f docker-compose.yml -f compose.services.yml up -d --build --scale agent=2
  ```

  改用 `ed25519`：

  ```bash
  eval "$(node server/service-keys.mjs compose)"   # 导出 INTERNAL_SERVICE_AUTH=ed25519、三把私钥和受信公钥
  docker compose -f docker-compose.yml -f compose.services.yml up -d --build
  ```

  - 内部身份只从 shell 读取，文件里没有默认值。`INTERNAL_SERVICE_SIGNING_KEY_API`、`_AGENT`、`_RETRIEVAL` 分别只映射到对应服务的 `INTERNAL_SERVICE_SIGNING_KEY`；`INTERNAL_SERVICE_TRUSTED_KEYS` 所有服务共用。
  - 缺密钥时 compose 不会在解析阶段报错，而是容器启动时拓扑校验拒绝启动、进程退出，`restart: unless-stopped` 会一直重启它。看到某个层反复重启，先查 `docker compose logs <服务>`。
  - 这几项变量也可能从 `server/.env` 流进各个层（`env_file`）：`INTERNAL_SERVICE_SIGNING_KEY_ID`、`INTERNAL_SERVICE_ISSUER`、`INTERNAL_SERVICE_REQUEST_BINDING`、`INTERNAL_SERVICE_REPLAY_CACHE`；model-gateway 服务没有覆盖 `INTERNAL_SERVICE_SIGNING_KEY`，`server/.env` 里如果有这个值会被网关继承。不要在 `server/.env` 里放私钥。
  - 它是追加在基础文件上的 override，不能和 `--profile app` 同时用（两者都占 5001）。多个 api 副本要把 `ARCHIVE_RAG_API_PORTS` 设成端口范围（例如 `5001-5003`），或者自己在前面放负载均衡。
  - `--scale` 起的副本共用一个 DNS 名（例如 `http://agent:5001`），service client 把它当成一个副本，负载靠 Docker DNS 在建连时分散。要用按副本的最少在途选择和故障转移，得在地址里逐个列出副本。
  - 这个文件还没有真正构建和启动过，只用 `docker compose config` 校验过解析，由 `test/deployment-contract.test.mjs` 固定。
- 仓库里没有 Kubernetes 清单。

### 内部身份与密钥

`INTERNAL_SERVICE_AUTH` 选签名方式，变量的完整说明见 [configuration.md](configuration.md#内部身份)。

**`hmac`（默认）：换密钥**

第一个密钥签名，所有密钥都能验证。逐个重启期间，新旧配置的进程同时在跑，所以分三轮：

1. 把新密钥加到最后：`INTERNAL_SERVICE_KEYS=k1:<旧>,k2:<新>`，逐个重启所有层。这时仍用 `k1` 签名，`k2` 只用于验证。
2. 所有层都换完后，把新密钥挪到最前面：`k2:<新>,k1:<旧>`，再逐个重启。这时用 `k2` 签名，还没重启的进程也认得它。
3. 最后删掉 `k1`，再逐个重启一次。

如果第一步就把新密钥放在最前面，先重启的进程会用 `k2` 签名，还没重启的进程不认识它，这些调用会被拒绝（公网入口转发 Agent 请求时返回 502 `SERVICE_IDENTITY_REJECTED`）。

**`ed25519`：生成和分发**

```bash
cd server
node service-keys.mjs generate api          # 第一行 INTERNAL_SERVICE_SIGNING_KEY=...（只给 api），第二行 api:<kid>:<公钥>
node service-keys.mjs generate agent
node service-keys.mjs generate retrieval
node service-keys.mjs generate ingest-worker   # 只有独立入库 worker 调用网关时才需要
```

- 工具只往标准输出打印，不写文件；提示信息走标准错误。私钥放进密钥管理或部署用的 shell，不要写进受版本控制的文件或 `server/.env`。
- 每个私钥只发给对应的那一个进程，作为它的 `INTERNAL_SERVICE_SIGNING_KEY`。
- 所有公钥条目用逗号连起来，作为每一层的 `INTERNAL_SERVICE_TRUSTED_KEYS`。一把公钥只对它登记的 issuer 有效。
- 模型网关不调用别人，不需要私钥，但需要受信公钥。
- `node service-keys.mjs public <issuer>` 从环境变量里的 `INTERNAL_SERVICE_SIGNING_KEY` 重新算出公钥条目，用来核对。
- 用 `compose.services.yml` 时，`node server/service-keys.mjs compose` 一次打印全部 `export` 行（见上面的"用镜像部署"）。

**从 `hmac` 不停机切到 `ed25519`**

1. 按上面生成密钥，给每一层加上 `INTERNAL_SERVICE_TRUSTED_KEYS` 和自己的私钥，`INTERNAL_SERVICE_KEYS` 先保留。
2. 逐个把每一层切到 `INTERNAL_SERVICE_AUTH=mixed`，被调用方先切：model-gateway、retrieval、agent、api。`mixed` 的层用 Ed25519 签名，所以它调用的层必须已经能接受 Ed25519；它仍接受还没切换的调用方的 HS256 token。
3. 全部切完后，逐个切到 `ed25519`（顺序不限），最后删掉 `INTERNAL_SERVICE_KEYS`。

回退是反过来：先全部切到 `mixed`（顺序不限），再按调用方先切的顺序（api、agent、retrieval、model-gateway）切回 `hmac`。

**`ed25519`：换某一层的密钥**

1. 用 `generate` 生成新的一对，把新的公钥条目追加到每一层的 `INTERNAL_SERVICE_TRUSTED_KEYS`，逐个重启。kid 默认是公钥指纹，新旧条目不会重名。
2. 把这一层的 `INTERNAL_SERVICE_SIGNING_KEY` 换成新私钥，重启它。它用新 key 签名，旧 token 在有效期内仍然有效。
3. 等过了 token 有效期（`INTERNAL_SERVICE_TOKEN_TTL_MS`，默认 60 秒），从所有层删掉旧的公钥条目，再逐个重启。

**两种模式都适用**

- 谁能调用谁由 `server/rag/service-identity.js` 的 `SERVICE_CALL_POLICY` 决定，在接收方执行：agent 只接受 api 和 all；检索层只接受 agent 和 all（健康探测另外接受 api）；模型网关接受 agent、all、api、ingest-worker、retrieval。
- 每次调用的 token 都绑定方法、路径和请求体摘要。内部链路上不要放会改写路径或请求体的代理。
- `ed25519` 下默认开启防重放，每个 token 只接受一次；多个副本要共享这个判断，设 `RAG_SHARED_STATE=redis`。

### 限制

- 只在一台机器上跑过，没有多机、Kubernetes 清单、服务发现或自动扩缩；副本列表写在环境变量里，增减副本要重启调用方。
- 所有层共用一个 PostgreSQL，它既是共享瓶颈，也是单点。
- 层间身份不是 mTLS，层间也没有加密。默认 `hmac` 下每一层都握有同一组密钥，能以任何 issuer 签名，而且默认没有防重放（token 在有效期内可重放，但已绑定方法、路径和请求体）。`ed25519` 下每层只能以自己的身份签名，默认开启防重放；防重放缓存按进程有上限，满了会淘汰最老的条目，没有 Redis 时不在副本之间共享。无论哪种模式，内部端口都必须只在内网可达，层间 TLS 要自己在前面加。
- `ed25519` 只在四个独立进程的测试里跑通过（`test/service-identity-split.test.mjs`，检索层用的是 local 向量库，不是 PostgreSQL）；没有在 Docker 镜像或 PostgreSQL 上的检索层里跑过。老的几组拆分测试（`service-roles`、`retrieval-service`、`model-gateway` 等）手工签发不带绑定的 token，只在 `hmac` 下通过。
- 没有 Redis 时，网关的配额、并发上限和熔断都按网关进程计算，多个网关副本时总量会超出设定值。
- 公网入口的 `AGENT_SERVICE_TIMEOUT_MS` 现在也是 agent 层上运行的截止时间：到点时进行中的检索和模型调用被中止，运行在下一个安全点以 `deadline_exceeded` 结束。数据库语句不取消；检索层收到调用方断开不会停，只在自己的截止时间到时返回 504；模型并发上限的排队不响应取消。检索层没有并发上限或准入控制。
- agent 层因为下游故障返回的 503（例如模型熔断）也会让入口把这个 agent 副本当作不健康，跳过 5 秒。
- 检索层或模型网关停掉时，`/chat` 返回 503 `AGENT_DEPENDENCY_UNAVAILABLE`（带 `Retry-After` 和 `dependency`），运行记为可重试的失败；单体里模型或数据库故障时也一样。以前这种情况返回 200，请用户批准 Web 搜索。
- 各进程的 `/metrics` 和 `deploy/prometheus/` 的告警规则没有在真实的 Prometheus 里加载过；`compose.services.yml` 没有设置 `METRICS_*`。
- 各层的 `/health` 不需要认证，会列出内部副本地址和密钥 id（不含密钥本身）；api 的 `/health` 每次都会探测每个 agent 副本。
- 拆分模式下检索请求有上限（`RETRIEVAL_SERVICE_MAX_*`），超长问题或配得过大的 topK 返回 400，单体没有这些限制。

## OIDC 登录和 RBAC（可选）

默认不启用：不设 `API_AUTH_OIDC_ENABLED` 和 `RBAC_MODE` 时，鉴权仍是静态 token / HS256 JWT / 关闭。所有变量见 `docs/configuration.md` 的“OIDC”和“RBAC”。

### 在本机跑开发 IdP

`server/dev-oidc-provider.mjs` 是一个只用于开发和测试的 OIDC provider：只绑定 127.0.0.1，`NODE_ENV=production` 时拒绝启动，所有状态在内存里，登录不校验密码（用 `login_hint` 或页面上的下拉框选用户）。它强制 Authorization Code + PKCE S256，code 一次性、60 秒有效；只有请求 `offline_access` 时才签发 refresh token，refresh token 轮换，复用旧的会吊销整组。不要把它接进 compose 或生产镜像。

```bash
cd server && npm run oidc:dev            # http://127.0.0.1:5556，启动时打印 admin secret
# 自定义用户：DEV_OIDC_USERS_FILE=./dev-oidc-users.json npm run oidc:dev
```

内置用户：`alice`（全局 `admin.operator`；workspace-a 的 `workspace.admin`，workspace-b 的 `workspace.viewer`）、`bob`（workspace-a 的 `workspace.member`）、`carol`（组 `archive-viewers`；workspace-b 的 `workspace.viewer`）。然后在 `server/.env`：

```env
API_AUTH_ENABLED=true
API_AUTH_OIDC_ENABLED=true
API_AUTH_OIDC_ISSUER=http://127.0.0.1:5556
API_AUTH_OIDC_AUDIENCE=archive-rag-api
API_AUTH_OIDC_CLIENT_ID=archive-rag-spa
API_AUTH_OIDC_REQUIRE_TYP=true
RBAC_MODE=enforce
```

`npm run dev` 打开 http://localhost:3000，前端从 `GET /auth/config` 读到 issuer 和 client id，点 Sign in 走 PKCE 登录。`POST /admin/rotate-keys`（带 `x-dev-oidc-admin-secret`，可选 `?drop_previous=1`）轮换签名密钥，用来演练 JWKS 轮换。

### 接真实 IdP

不论哪家 IdP，需要准备：

1. 一个 public client（SPA）：Authorization Code + PKCE，不用 client secret；登记回调地址 `http://localhost:3000/`（开发）或 `https://<你的域名>/`（单容器部署是 `http://localhost:5001/`）；允许 SPA 的 origin 跨域访问 discovery 和 token 端点。它的 client id 填 `API_AUTH_OIDC_CLIENT_ID`。
2. 一个代表 API 的 audience，填 `API_AUTH_OIDC_AUDIENCE`。不要用 SPA 的 client id 当 audience；如果 IdP 只能这样做，设 `API_AUTH_OIDC_REQUIRE_TYP=true`，前提是它签发 `typ: at+jwt`。
3. `API_AUTH_OIDC_ISSUER` 必须与 discovery 文档里的 `issuer` 一字不差，包括末尾斜杠。
4. 角色：全局角色放进 roles claim（或用组 + `API_AUTH_OIDC_GROUP_ROLE_MAP`），按 workspace 的角色放进 `workspace_roles`，允许的 workspace 放进 `workspaces`。没有 `workspaces` / `workspace_id` 的 token 可以用 `x-workspace-id` 选任意 workspace，生产环境应保证每个用户都有该 claim，并在角色配齐后设 `RBAC_DEFAULT_ROLE=none`。
5. claim 名按点号拆成路径，所以名字里本身含点的 claim（例如 `https://archive.example.com/roles`）无法引用，请用不含点的名字。

**Keycloak**：issuer 是 `https://<host>/realms/<realm>`。给 SPA client 加一个 Audience mapper，把 `archive-rag-api` 写进 access token 的 `aud`（默认只有 `account`）；access token 的 `azp` 就是 SPA client id。realm 角色在 `realm_access.roles`，设 `API_AUTH_OIDC_ROLES_CLAIM=realm_access.roles`；组用 Group Membership mapper（关掉 full path）输出到 `groups`。`workspaces` / `workspace_roles` 用 User Attribute mapper（多值或 JSON 类型）。

**Auth0**：issuer 是 `https://<tenant>.auth0.com/`（带末尾斜杠）。在 APIs 里建一个 API，identifier 即 `API_AUTH_OIDC_AUDIENCE`；前端在 authorize 请求里带 `audience` 参数（`/auth/config` 返回 audience 时 SPA 会自动带上），否则 Auth0 会签发不透明 token。用 Post-Login Action 写入 `roles`、`workspaces`、`workspace_roles` 等不带命名空间的自定义 claim。access token 里有 `azp`。

**Azure AD / Entra ID**：issuer 是 `https://login.microsoftonline.com/<tenant-id>/v2.0`。为 API 注册一个应用，manifest 里设 `accessTokenAcceptedVersion: 2`（v1 token 用 `appid` 而不是 `azp`，会被拒绝），`aud` 就是这个 API 应用的 client id（GUID），把它填进 `API_AUTH_OIDC_AUDIENCE`；SPA 申请 `api://<api-app-id>/<scope>` scope（写进 `API_AUTH_OIDC_SCOPES`）。App roles 在 `roles` claim；组 claim 是对象 ID，`API_AUTH_OIDC_GROUP_ROLE_MAP` 的键要用 GUID。`workspaces` / `workspace_roles` 这类自定义 claim 需要 claims mapping policy 或目录扩展属性，做不到时可以只用全局 app roles 加 `RBAC_DEFAULT_ROLE`。

### RBAC 在部署里的位置

`RBAC_MODE=enforce` 时检查在 `requireApiAuth` 之后、路由之前。拆分部署里由 api edge 在转发前检查，agent 层不挂 RBAC，只信任 edge 签名的内部身份，所以 agent 层的端口不能暴露到公网。`workspaceRoles` 不随内部身份转发，这在 RBAC 只在 edge 执行时不影响结果。

### OIDC 和 RBAC 的限制

- 浏览器端不校验 ID token 签名（public client），API 只认 access token。
- refresh token（如有）放在 sessionStorage，XSS 可读。
- workspace id 的权限匹配不区分大小写。token 列了允许的 workspace 时，数据库租户统一用列表里的小写形式，请求头写成 `ACME` 也落在 `acme`；token 没列时按请求头原样使用，此时只差大小写的两个 workspace 是两个租户，按 workspace 授予的角色只在小写形式完全一致的那个里生效。仍建议 workspace id 统一用小写。
- 没有 `WWW-Authenticate` 头，健康报告也不含 JWKS 状态。
- `RBAC_MODE=enforce` 时不在路由表里的路径返回 403 而不是 404。

## 读副本（可选）

检索可以交给 PostgreSQL 的流复制热备。默认关闭；不设 `POSTGRES_READ_REPLICA_URLS` 时一切照旧。变量和一致性设计见 [configuration.md](configuration.md#读副本)。

### 副本的前提

- 副本是同一个数据库的流复制热备（`hot_standby=on`），由你自己用 PostgreSQL 的流复制搭好；仓库的 compose 文件里没有副本服务。
- 只有带访问范围的请求会分流（开启鉴权，或请求带 `x-user-id` / `x-workspace-id`），并且要保持 `POSTGRES_ROW_LEVEL_SECURITY=enforce`（默认）。没有访问范围的请求或关闭行级安全时，语句都以 owner 身份在主库执行，配了副本也不会有任何分流，`/health` 也不会提示这一点。
- 只分流 pgvector 的检索语句（稠密和稀疏）。写入、迁移、文档列表、文件下载、运行和任务的读接口都留在主库。

### 打开

```bash
POSTGRES_READ_REPLICA_URLS=postgresql://app:<密码>@replica-1:5432/agentai,postgresql://app:<密码>@replica-2:5432/agentai
POSTGRES_READ_REPLICA_MAX_LAG_MS=2000
```

- 设置在做检索的进程上：单体，或拆分部署的检索层（agent 层没设 `RETRIEVAL_SERVICE_URL` 时也在本地检索）。拆分部署下检索层会从主库重读请求里的每个 docId，作为一致性的锚点。
- 检查：`curl -s http://localhost:5001/health` 里的 `checks.readReplicas` 列出每个副本的状态、延迟、熔断和被排除的原因。副本落后、宕机或熔断时只报 `warning`，`/ready` 仍是 200，读取回到主库；只有配置写错才报 `error`。
- 指标：`archive_rag_postgres_reads_total{target}`、`archive_rag_postgres_replica_fallbacks_total{reason}`、`archive_rag_postgres_replica_lag_seconds{replica}`（需要 `METRICS_ENABLED=true`）。

### 在本机试

```bash
cd server
bash scripts/run-pgvector-replica-integration.sh
```

脚本用 Postgres.app 的 `initdb` 和 `pg_basebackup -R` 在 `$TMPDIR` 下起一个一次性主库（`wal_level=replica`）和一个流复制备库，端口由系统分配（不会用 5432 或 5434），跑 `test/postgres-replica.integration.test.mjs`，退出时停库并删除目录。可选 `KEEP_CLUSTER=1`（保留两个库）、`PG_BIN_DIR`、`PGVTEST_DB`。测试用 `pg_wal_replay_pause` 暂停副本重放，然后在一个实例上上传、替换、删除文档，在两个实例上 `/chat`，确认回答里没有缺失、过时或已删除的内容，回退都被计数，恢复重放后读取回到副本。

压测时加副本：`bash scripts/run-load-test-pgvector.sh --read-replica --tenant [其他参数]`，报告里多出路由计数和主备两个节点各自的语句数。

### 读副本的限制

- 只在一台机器上测过：主库和副本在同一台主机上，副本延迟和网络距离都和真实部署不同。
- 副本上的语句只有连接超时，没有语句超时，也不受请求截止时间限制。
- `vector:reindex --apply` 期间，落后的副本可能对重新向量化的文档返回空的稠密结果，直到追上（受延迟上限约束）。
- `/chat` 开始时的注册表刷新失败只打日志；这时落后但仍在延迟上限内的副本可能返回替换前的内容，直到追上。
- 不检查副本是否真的跟随这个主库。

## 截止时间和取消（可选）

```bash
AGENT_REQUEST_TIMEOUT_MS=120000     # 一个 Agent 请求最多 120 秒，到点时运行以 deadline_exceeded 结束，返回 504
AGENT_CANCEL_ON_DISCONNECT=on       # 客户端断开时取消运行（运行记为 canceled）
```

- 两个开关默认都关，单体行为不变。拆分部署的 agent 层总是带着入口的 `AGENT_SERVICE_TIMEOUT_MS`。
- 到点后，进行中的模型和检索调用被中止，运行在下一个安全点（阶段、步骤、图节点开始前，finalize 前）停下。已经开始的写工作区的 Capability 会跑完，不会被打断。
- 客户端看到的：超时 504 `AGENT_DEADLINE_EXCEEDED`；依赖故障 503/504 `AGENT_DEPENDENCY_*` 带 `Retry-After`；`/chat/stream` 以 `error` 和 `done` 结束。细节和已知边界见 [configuration.md](configuration.md#截止时间取消和依赖故障)。
- 依赖故障返回 503 是默认行为，不需要开关：以前模型或检索不可用时 `/chat` 返回 200 并请用户批准 Web 搜索。

## 指标与告警（可选）

### 打开指标

```bash
METRICS_ENABLED=true
METRICS_PORT=9464          # 默认值；同一台机器上的多个进程要各用一个端口，或设 0 由系统分配
METRICS_HOST=127.0.0.1     # 默认值；Prometheus 在别的容器或主机上时设 0.0.0.0
METRICS_TOKEN=<随机字符串>  # 绑定 0.0.0.0 时一定要设
```

- 每个进程在单独的端口上提供 `/metrics`，应用端口不提供。启动日志有一行 `[metrics] serving /metrics on http://HOST:PORT`。
- 检查：`curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:9464/metrics | head`。
- 变量和指标族见 [configuration.md](configuration.md#prometheus-指标)。

### 接 Prometheus

`deploy/prometheus/` 有三个文件：

| 文件 | 内容 |
| --- | --- |
| `prometheus.example.yml` | 抓取配置示例：job `archive-rag`，每个目标都要带 `role` 标签（`all`、`api`、`agent`、`retrieval` 或 `model-gateway`），token 从 `credentials_file` 读。 |
| `recording-rules.yml` | `/chat` 的可用性 SLI 和延迟 SLI，各 5m、30m、1h、6h 四个窗口。只算公网入口（`role=~"all\|api"`）。 |
| `alert-rules.yml` | SLO 燃烧率告警和运维告警，每条都有 severity、summary、description 和 runbook。 |

```bash
cp deploy/prometheus/*.yml /etc/prometheus/       # 按自己的目标改 prometheus.example.yml
echo -n "$METRICS_TOKEN" > /etc/prometheus/archive-rag-metrics-token
prometheus --config.file=/etc/prometheus/prometheus.example.yml
```

- 规则里的指标序列不带 `role`、`instance`、`job`，全部由抓取配置加；漏了 `role` 标签，SLI 选不到任何序列。
- 拆分部署时 `/chat` 在入口和 agent 层各记一次，规则只取入口。
- Docker 部署：`docker-compose.yml` 和 `compose.services.yml` 都没有设置 `METRICS_*`，也没有 Prometheus 服务；要在容器里抓取，给每个服务加 `METRICS_ENABLED=true`、`METRICS_HOST=0.0.0.0`、`METRICS_TOKEN`，并把 Prometheus 放进同一个 compose 网络（示例里的目标名 `app:9464`、`api:9464` 等就是按这个写的）。仓库里没有现成的 compose 配置。
- 告警怎么处理见 [operations.md](operations.md)。

### 指标和规则的限制

- 规则没有用 promtool 检查过，也没有在真实的 Prometheus 里加载和求值过；只经过 `test/metrics-rules.test.mjs` 里的 YAML 子集解析和"每个指标、标签都存在"的检查。
- 99.5% 可用性和 95% 在 20 秒内这两个目标是建议值，没有实测依据。
- 没有 Alertmanager 的路由和通知配置。
- 不设 `METRICS_TOKEN` 的回环监听不检查 Host 头；暴露内容里按设计没有租户数据。
- 事件循环 p99 在每次抓取时重置，两个 Prometheus 同时抓时各看到一半的窗口。

## CI 里的真实模型评测

`.github/workflows/real-model-eval.yml`：每周一定时跑，也可以手动触发，手动时可以指定对话模型，以及 QASPER 答题的题数。

- 在 GitHub 的 CPU 机器上装 Ollama，拉取 `nomic-embed-text` 和对话模型（默认 `qwen2.5:7b`）。模型有缓存，不需要任何 API key。
- 三步评测：
  1. `verify:quality`：18 项端到端检查，任何一项阻断失败，整个 job 就失败；
  2. QASPER dev 抽样 200 题，测证据能否进入问答候选；召回低于 0.6 就失败（设定下限时实测为 0.655）；
  3. QASPER dev 答题，默认 40 题，只出报告，不设门槛。CPU 上 7B 模型大约一分钟答一题。
- 报告作为 `real-model-eval` artifact 上传；前面的步骤失败也会上传。
- 首次运行（2026-09-26）约 63 分钟通过：`verify:quality` 18/18，召回 0.655，和本机结果一致。
