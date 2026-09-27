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
- 停机：收到 SIGTERM 或 SIGINT 后停止领取新任务，给运行中的任务 5 秒；没完成的归还队列（不计入尝试次数），其他 worker 可以立即接手。进程被强制结束时，任务在租约过期后由其他 worker 重试。
- 从 `async` 切回 `sync` 前先等队列清空：`sync` 下 API 进程不运行 worker，剩下的任务要靠 `npm run worker:ingest`。

### 其他说明

- 镜像构建时把 `VITE_DOMAIN` 设成 `same-origin`。构建参数 `VITE_API_AUTH_TOKEN` 会打进前端包、发给每个浏览器，只适合单个可信用户。多用户部署用 `API_AUTH_TOKENS`，由前端之外的方式分发 token。
- 镜像以非 root 用户 `node` 运行，只有 `/data` 可写。
- 镜像里的 npm 10 在安装服务端依赖时会要求 `@qdrant/js-client-rest` 的 peer 依赖 typescript。本机 npm 11 生成的锁文件里没有它，而运行时也用不到，所以 Dockerfile 用 `--legacy-peer-deps` 安装。

## CI 里的真实模型评测

`.github/workflows/real-model-eval.yml`：每周一定时跑，也可以手动触发，手动时可以指定对话模型，以及 QASPER 答题的题数。

- 在 GitHub 的 CPU 机器上装 Ollama，拉取 `nomic-embed-text` 和对话模型（默认 `qwen2.5:7b`）。模型有缓存，不需要任何 API key。
- 三步评测：
  1. `verify:quality`：18 项端到端检查，任何一项阻断失败，整个 job 就失败；
  2. QASPER dev 抽样 200 题，测证据能否进入问答候选；召回低于 0.6 就失败（设定下限时实测为 0.655）；
  3. QASPER dev 答题，默认 40 题，只出报告，不设门槛。CPU 上 7B 模型大约一分钟答一题。
- 报告作为 `real-model-eval` artifact 上传；前面的步骤失败也会上传。
- 首次运行（2026-09-26）约 63 分钟通过：`verify:quality` 18/18，召回 0.655，和本机结果一致。
