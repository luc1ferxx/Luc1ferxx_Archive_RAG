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

### 多实例共享状态（可选）

```bash
RAG_SHARED_STATE=redis docker compose --profile app --profile shared-state up -d
```

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
