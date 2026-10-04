# Configuration

这份文档只放配置细节。快速启动入口见 [README](../README.md)。

## 环境文件

```bash
cp .env.example .env
cp server/.env.example server/.env
```

前端读取根目录 `.env`，后端读取 `server/.env`。

数字类变量留空（`VAR=`）或只写空白，等同于没设置，使用默认值，不会被当成 `0`。要设成 `0` 就显式写 `0`，例如 `RAG_LLM_MAX_CONCURRENCY=0` 仍表示不限并发。所以 `server/.env.example` 里留空的 `RAG_LLMOPS_MAX_COST_USD_PER_EVENT` / `RAG_LLMOPS_MAX_TOKENS_PER_EVENT` 表示不设预算，而不是预算为 0。

### Docker Compose 变量

下面两个变量由 `docker compose` 在解析 compose 文件时读取，要在执行命令的 shell 里设置（compose 也会读仓库根目录 `.env` 里的同名变量）；写在 `server/.env` 里不起作用。用法和注意事项见 [deployment.md 的"端口与网络暴露"](deployment.md#端口与网络暴露)。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `ARCHIVE_RAG_BIND_HOST` | `127.0.0.1` | 所有发布端口绑定的宿主机地址：`postgres` 5432、`redis` 6379、`app` 5001、`docling` 5010，以及 `compose.services.yml` 的 `api`。默认只能从本机访问；设成 `0.0.0.0` 或某块网卡的地址会让这些端口一起对外，Redis 没有密码，先设好 `POSTGRES_PASSWORD` 并开启 API 鉴权。 |
| `POSTGRES_PASSWORD` | `postgres` | `postgres` 服务的密码，也拼进 compose 里所有的数据库地址（`POSTGRES_DATABASE_URL`、`LONG_MEMORY_DATABASE_URL`）。原样拼进 URL，只用 URL 安全的字符（例如 `openssl rand -hex 24`）。只在 `pgdata` 卷第一次初始化时生效；已有数据卷要先在库里 `ALTER USER`。 |

## 最小后端配置

```env
OPENAI_API_KEY=your_openai_api_key
SERPAPI_KEY=your_serpapi_key

POSTGRES_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/agentai
POSTGRES_SSL_ENABLED=false

VECTOR_STORE_PROVIDER=pgvector
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_CHAT_MODEL=gpt-5

RAG_CHUNK_STRATEGY=structured
RAG_CHUNK_SIZE=900
RAG_CHUNK_OVERLAP=180
RAG_RETRIEVAL_TOP_K=6
RAG_COMPARE_TOP_K_PER_DOC=3

STARTUP_HEALTH_STRICT=false
```

## 前端配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `VITE_DOMAIN` | `http://localhost:5001` | 后端 API 地址。 |
| `VITE_API_AUTH_TOKEN` | 空 | 启用 API auth 时，前端通过 `x-api-key` 发送的 token。有 OIDC 会话时不再发送，改发 `Authorization: Bearer`。 |
| `VITE_OIDC_ISSUER` | 空 | OIDC issuer。只在 `GET /auth/config` 不存在或不可达时作为回退；该端点返回 `mode: "token"` 或 `"disabled"` 时不启用 OIDC。 |
| `VITE_OIDC_CLIENT_ID` | 空 | SPA 的 public client id（同上，只作回退）。 |
| `VITE_OIDC_SCOPES` | `openid profile email` | 登录 scope；总会补上 `openid`。 |
| `VITE_OIDC_AUDIENCE` | 空 | 非空时在 authorize 请求里附带 `audience` 参数（Auth0 风格）。 |
| `VITE_OIDC_REDIRECT_URI` | `${window.location.origin}/` | 回调地址，必须在 IdP 登记（开发 `http://localhost:3000/`，单容器 `http://localhost:5001/`）。 |
| `VITE_OIDC_POST_LOGOUT_REDIRECT_URI` | 同 redirect URI | IdP 提供 `end_session_endpoint` 时，退出后的回跳地址。 |

## 后端基础配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 无 | 生成 embeddings 和回答所需。 |
| `SERPAPI_KEY` | 无 | Web answer 搜索所需；只跑文档 RAG 可先不配。 |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | 文档 chunk 与 query 的 embedding 模型。 |
| `OPENAI_CHAT_MODEL` | `gpt-5` | 文档答案、对比答案、网页摘要使用的模型。 |
| `RAG_INJECTION_SCREEN` | `on` | 检索切块、上传文件名和网页结果进入 prompt 前，是否筛掉对 AI 说话的句子（`on` / `off`，无法识别的值按 `on` 处理）。`off` 只作为生产环境出现误判时的紧急开关；答案 prompt 里的不可信证据规则和输出链接守卫不受影响。见 `docs/agent-rag.md` 的“Prompt 注入防护”。 |
| `RAG_CLAIM_JUDGE` | `off` | 词法 claim 校验拒绝的 claim 是否交给 LLM 评审复核（`llm` / `off`）。只作用于文档问答的自检和 finalizer；评审只能把"无支持"改成"有支持"，不能反过来，引用错误、证据里没有的数字、对比答案都不送评审，评审失败则保留词法结论。每个答案多一次模型调用，结论按 claim + 证据缓存。评审用的是同一个 chat 模型，还没有用人工标注的真实答案校准，见 [evaluation.md](evaluation.md)。 |
| `RAG_STRUCTURED_OUTPUT_ENABLED` | `true` | intent / execution / DAG planner 调用是否发送按请求生成的 JSON Schema `response_format`（strict）。schema 由运行时白名单生成：可选 step、候选 intent、Skill 的 typed 输入输出和已授权文档都写成枚举，自由文本和数组都有长度上限。它只收窄模型能输出什么，validator 仍是最终裁决。仅当 OpenAI 兼容端点拒绝 `response_format` 时设为 `false`，此时回到纯 prompt JSON 和容错解析。 |
| `OPENAI_CHAT_FALLBACK_MODEL` | 无 | 可选的备用 chat 模型。chat、intent planner、execution planner 路由上，主模型在重试用尽后仍返回可重试错误（429、5xx、超时）时切到它；400/401、策略或预算拦截不会切换。它经模型注册表登记，与主模型共用 workspace 策略标签，被策略禁用的主模型不会通过备用模型绕过。LLMOps 会分别记录主模型失败事件和备用模型成功事件，返回的 `modelRoute.modelId` 是实际作答的模型，`status` 为 `failover`。 |
| `RAG_LLM_REQUEST_TIMEOUT_MS` | `120000` | 单次模型请求（含读取响应体）的超时。超时按可重试错误处理。重试采用带抖动的指数退避（窗口 500/1000/2000ms），服务端 `retry-after-ms` / `Retry-After` 作为下限并再分散最多一半，超过 10 秒的等待直接放弃重试；空 completion 重试一次，因长度截断而为空的不重试。 |
| `RAG_LLM_MAX_CONCURRENCY` | `8` | 每个模型端点（base URL + 模型名）同时在途的请求上限，按进程计；`0` 不限。只在请求真正发出期间占用名额，重试的退避等待不占。它防的是自托管服务（Ollama、vLLM）排队过长：队列超过请求超时后，客户端超时重试、服务端还在处理已放弃的请求，负载越积越多。它不是按每分钟请求数或 token 数的限流。 |
| `RAG_LLM_CIRCUIT_FAILURE_THRESHOLD` | `5` | 同一端点和模型连续多少次"不可用"错误（5xx、408、超时、连接失败）后熔断；`0` 关闭。429、其他 4xx 和空响应不计入：429 说明服务在线，交给退避处理。熔断期间请求不发出、也不重试，直接以 `CIRCUIT_OPEN`（503）失败，chat 路由有备用模型时立即切换。 |
| `RAG_LLM_CIRCUIT_COOLDOWN_MS` | `30000` | 熔断持续时间。到期后放行一个探测请求：成功则恢复，失败则再熔断一个周期。熔断状态默认按进程保存；`RAG_SHARED_STATE=redis` 时由所有实例共享。 |
| `RAG_MIN_QA_QUERY_TERM_COVERAGE` | `0.51` | 单文档问答的查询词覆盖下限，和对比用的 `RAG_MIN_QUERY_TERM_COVERAGE` 分开。它决定整道题答不答；决定要答之后，模型看到的上下文还会补上其余候选段落，最多补到 `RAG_RETRIEVAL_TOP_K` 条，近邻替换的段落不补（见 evaluation.md 的“门控：判定和上下文分开”）。调低会少拒答措辞不同的问题，但也会放进相邻话题的段落（问"育儿假"却拿年假条款回答）；在 QASPER dev 上调到 0.2，拒答从 41.7% 降到 7.2%，但官方 F1 从 0.206 降到 0.153。见 [evaluation.md](evaluation.md) 的“拒答门控调参”。 |
| `RAG_QA_ANSWER_VERDICT` | `false` | 单文档问答的第二个拒答信号。打开后，QA prompt 换成 `qa_answer` v1.3 / v2.3：证据答不了时，模型以 `NOT_IN_EVIDENCE:` 开头回复，服务端把它当成拒答（`abstainSource: "answer_model"`，不带引用，也不作为流式草稿发出）。同时打开下面的部分覆盖补救区。默认关闭：用 qwen2.5:7b 在 QASPER dev 上测，可回答题拒答从 41.7% 升到 51.7%，作答题 F1 从 0.215 升到 0.281，总 F1 没有显著变化；`verify:quality` 里还有一次把正确答案标成"没有"。换更强的模型前，先用这两项重新测一遍。见 [evaluation.md](evaluation.md) 的“两段式拒答”。 |
| `RAG_QA_PARTIAL_COVERAGE_FLOOR` | `0.3` | 只在 `RAG_QA_ANSWER_VERDICT` 打开、且问题没被拆成多个子问题时生效。查询词覆盖在这个值到 `RAG_MIN_QA_QUERY_TERM_COVERAGE` 之间的段落也放行，前提是没有"近邻替换"：问题里的词在段落里被同一中心词前的另一个词替换了，比如问 parental leave，段落里是 annual leave。设为不低于问答覆盖下限的值即关闭补救区。 |
| `RAG_QA_VERDICT_RETRY_TOP_K` | `18` | 只在 `RAG_QA_ANSWER_VERDICT` 打开时生效。模型回复 `NOT_IN_EVIDENCE:` 后，按这个深度再检索一次，从模型没看过、且通过同一门控的段落里取最多一份正常上下文的量（`RAG_RETRIEVAL_TOP_K` 条），让模型再答一次；没有新段落通过门控，就维持拒答。只重试一次。`0`（或不大于 `RAG_RETRIEVAL_TOP_K`）关闭。 |
| `RAG_QA_VERDICT_OVERRIDE` | `off` | 只在 `RAG_QA_ANSWER_VERDICT` 打开时生效，取值 `off` / `supported`，其他值都按 `off`。`supported` 时，以 `NOT_IN_EVIDENCE:` 开头的回复如果标记后面的内容能证明自己，就仍然作答：先去掉谈论证据本身的句子（"文档没有说明……"、"……未明确规定"、"问题问的是……"），这些句子不算 claim；例外是这种句子在 beyond / other than / except (for) / apart from / aside from / besides / ", only" 之后的后半句（"do not specify X beyond stating that <事实> [Source 1]"，即 qwen2.5:7b 在 `verify:quality` 里的写法），它作为单独的 claim 照常校验，前半句仍然去掉；后半句必须是陈述（由 that 引出，或含谓语），光秃秃的名词短语（"other than indirect damages"）借的是前半句没人校验的动词，直接丢掉。指出答案在哪里的句子（"is defined in Schedule 2"、"see Table 3"）也算 hedge。剩下的事实 claim 至少一条自带 `[Source N]`，并且每一条都通过和 finalizer 相同的词法 claim 校验（数字必须出现在所引证据里，来源和归属检查；不调用 claim 评审），校验用模型实际看到的证据：被提示注入过滤掉的句子不算支持。这些 claim 必须覆盖问题的全部 anchor（标识符、引号短语，即门控的 anchor 检查），至少有一个查询词出现在 claim 里，claim 和它们引用的证据都不能出现"近邻替换"（问 parental leave 答 annual leave）。问题里的名称（数字；首字母之后还有大写的词，如 BERT；句首以外大写开头的词；单个字母连同前一个词，如 "Vendor B" / "vendor b"；全标题大小写或全大写的问题里，大小写不算数）必须出现在 claim 里，也出现在所引证据或其文件名里。必须有一条 claim 单独承担答案：它提到问题的全部名称、名称之外的至少一个查询词，并且说出问题里没有的内容（是非题则要提到全部查询词）；只复述问题（"Limitation of Liability [Source 1]"）或把名称分散在两条 claim 里都不算。被查询拆分器拆成多个子问题的问题从不覆盖。理由句如果点名了问题中的词说它们缺失（"没有描述退款政策"），claim 至少要提到其中一个；谈论证据本身的词和紧跟在 other / additional 等词后面的词不算点名。这一条宁可拒答。满足时答案是去掉这些句子后的文本，带原有引用，`abstainSource: null`，`verdictOverridden: true`；RAG trace 记录 `verdictOverride`（只有原因代码和计数），Agent 的 `document_rag` 步骤输出多一个 `verdictOverridden: true`。以标记开头的回复仍然不作为流式草稿发出；对比路径不读拒答标记，不受影响。局限：问题没有 anchor、名称、也没有近邻词对时，它分不清"回答了问题"和"同一主题另一方面的、有引用支持的事实"；小写写出的实体名不算名称。默认关闭。第三轮测量用的候选是评审 + 拒答标记 + 7 个开关 + 本开关，在 QASPER train seed 4 上：覆盖判断了 42 次，作答 0 次，因为 7B 模型的标记回复大多没有带引用的事实句；候选还答了 1/7 道不可答题（基线 0/7），走的是普通作答路径，不是覆盖。所以没有通过，默认值不变。见 [evaluation.md](evaluation.md) 的"拒答标记覆盖"和"第三轮：拒答标记的确定性复核"。 |
| `AGENT_FOLLOW_UP_ORIGINAL_QUESTION` | `false` | Agent 文档循环的 follow-up 不再把 "Re-check the uploaded documents…" 元文本当问题：答案模型拿到的是主调用已解析的原问题，证据缺口只进 follow-up 的检索查询；follow-up 调用跳过会话记忆改写；它的 QA 门控按原问题重算每个候选的查询词覆盖。follow-up 的答案仍过同一个校验器。图路径的 `document_evidence_check` 同样生效。以下 7 个开关在 QASPER train（Agent 路径，qwen2.5:7b，50 题）上测过：评审关时单开或全开都没有多答一道题；只有和 `RAG_CLAIM_JUDGE=llm` 一起开才多答，但同时答了原本拒掉的不可答题，所以都保持关闭。见 [evaluation.md](evaluation.md) 的“Agent 答题率开关”。 |
| `RAG_QA_GATE_INFLECTION` | `false` | 单文档 QA 门控把屈折变化算作命中（governs/governed、metrics/metric；`rag/inflection.js`，只处理 -s/-es/-ies/-ed/-ing，不处理派生词和前缀；数词（seconds/second、thirds/third、tens/ten）和少数异义词（news、means、united、goods、premises、evening）只精确匹配）。只作用于有屈折命中的块，取原分数与屈折覆盖的较大者，从不降低分数。anchor、数字、近邻替换否决、对比和 rerank 门控不变。 |
| `RAG_CLAIM_INFLECTION` | `false` | 词法 claim 校验把证据里的屈折形式算作 claim 词出现。数字、anchor、极性、情态、关系顺序、归属检查不变；对比答案不受影响。 |
| `RAG_CLAIM_HEADING_CONTEXT` | `false` | 词法 claim 校验额外把被引块里每条证据句与它所属章节标题拼起来再校验（"Limitation of Liability: The total liability …"），让点明章节的答案（"The limitation of liability is that …"）能通过。标题只来自 "Section/Article N" 行或块自身的章节标题，须 Title Case、不超过 8 个词、无否定；标题里的数字会去掉。裸编号行和无编号的 Title Case 行（"2. Interns"、"Parental Leave"，列表项也长这样）不当标题，但会结束上一个标题的范围，被拒的 Section 行也一样。claim 必须把标题当短语说出来，且标题以外的每个词都在句子本身里：标题只能补章节名，不能补主体、当事方或事实。对比答案不受影响。 |
| `RAG_CLAIM_SOURCE_INHERITANCE` | `false` | 没有 `[Source N]` 的答案句继承同一行里最近的带标签句的标签（先找后面的，再找前面的），不跨行；继承的标签和手写的一样校验，finalizer 会把通过的标签写出来。对比答案不受影响。 |
| `RAG_CLAIM_JUDGE_TEMPERATURE` | 未设置 | 设置后（0–2）随 claim 评审请求发送该 temperature，评审缓存键也带上它；未设置时不发送，用服务端默认值。 |
| `AGENT_SINGLE_DOCUMENT_ROUTING` | `false` | 确定性意图规则的三处收紧：只选一份文档且没提到另一份文档时，比较类措辞走文档问答（提到 "the other agreement""these documents" 等仍走比较澄清）；连字符名字里的 "sequence"（RAG-Sequence）不算时间线请求；"this/the/our study" 不算研究简报请求。 |
| `RAG_EMBEDDING_QUERY_PREFIX` / `RAG_EMBEDDING_DOCUMENT_PREFIX` | 按模型 | embedding 模型要求的任务前缀，只加在真实的 embedding 请求上。nomic-embed-text 默认用 `search_query: ` / `search_document: `（官方要求）。在 QASPER dev 上，证据段落进入问答候选的比例从 0.648 升到 0.692（配对 +0.044 [+0.021, +0.067]）；其他模型默认不加。设为空字符串即关闭。文档前缀属于"索引标识"，改了之后已有索引不能再检索：pgvector 会直接报错，local 和 Qdrant 对这些分块不给向量分。需要运行 `npm run vector:reindex -- --from documents --apply` 重建。**用 nomic-embed-text 的已有索引，升级后需要重建一次。** |
| `PDF_PARSER` | `pdfjs` | PDF 文本提取方式。`pdfjs` 在进程内解析；`docling` 把文件交给 docling-serve 做版面解析，多栏按阅读顺序输出，表格还原成"列名: 值"的行。其他值在入库时直接报错。上传、`archive-ingest` 和 `vector:reindex` 都走这里。 |
| `DOCLING_SERVE_URL` | `http://127.0.0.1:5010` | docling-serve 地址。它在容器里监听 5001，和后端默认端口相同，所以本地映射到 5010；compose 里指向 `http://docling:5001`。 |
| `DOCLING_TIMEOUT_MS` | `300000` | 单个 PDF 的解析超时。CPU 上一篇 10 页的论文约 12 秒。 |
| `DOCLING_OCR` | `false` | 是否做 OCR。文字型 PDF 不需要，扫描件才打开，会慢很多。 |
| `DOCLING_FALLBACK` | `pdfjs` | docling-serve 失败时的处理方式：`pdfjs` 改用 pdf.js 解析，并打印原因；`none` 让上传直接失败。 |
| `FRONTEND_BUILD_DIRECTORY` | 空 | 设置后 API 服务同时托管前端构建产物，单容器部署会用到。静态文件挂在限流和 API 鉴权之前；前端没有客户端路由，所以不做 `index.html` 回退，不会挡住 API 路径。 |
| `RAG_SHARED_STATE` | `memory` | 熔断器、模型并发上限和 claim 评审缓存的状态存在哪里。`memory` 按进程保存，适合单实例；`redis` 让所有指向同一 `REDIS_URL` 的实例共享：一个实例打开的熔断对所有实例生效，并发上限按整个部署计算，评审结论跨实例复用。Redis 不可达时每个实例退回进程内状态，不会让模型调用失败，健康检查的 `checks.sharedState` 会报 `error`。 |
| `REDIS_URL` | `redis://127.0.0.1:6379` | `RAG_SHARED_STATE=redis` 时使用的 Redis。本地可用 `docker compose --profile shared-state up -d` 启动。 |
| `RAG_SHARED_STATE_PREFIX` | `archive_rag:` | 共享状态的 key 前缀，让多个部署或测试共用一个 Redis 时互不干扰。 |
| `AGENT_RUN_MAX_TOKENS` | `100000` | 每次 Agent 运行的模型 token 上限（chat、embedding、rerank 合计，按 LLMOps metric 计）。用完后下一个工具被跳过并写 `budget_limit` trace，运行降级而不报错；`0` 关闭，空值保留默认。见 [agent-rag.md](agent-rag.md#运行预算次数之外的-token成本和时长)。 |
| `AGENT_RUN_MAX_COST_USD` | `0.5` | 每次运行的估算成本上限，只约束有定价的模型；无定价调用记入 `unpricedModelCalls`。 |
| `AGENT_RUN_MAX_DURATION_MS` | `300000` | 每次运行的总时长上限，在步骤边界检查：不再开始新工具，不中断进行中的调用。审批续跑从续跑时重新计时。 |
| `AGENT_PLANNER_ROLLOUT` | `llm` | AgentRAG planner 灰度模式；`configured` 使用下面两个显式 planner 变量，`shadow` 执行 deterministic 主路径并把 LLM intent/execution proposal 记录到 `agentObservability.*Planner.shadow`，`guarded_llm` 让 LLM 作为主 planner 但继续由 validator/fallback 兜底，`llm`/`deterministic` 会同时覆盖 intent 和 execution planner。 |
| `AGENT_INTENT_PLANNER` | `llm` | AgentRAG intent 选择器；`deterministic` 使用规则候选首选项，`llm` 让 LLM 在白名单候选 intent 中选择并由 validator 兜底。 |
| `AGENT_EXECUTION_PLANNER` | `llm` | AgentRAG execution step 规划器；`deterministic` 使用固定 step schema，`llm` 让 LLM 在白名单 step 中排序并由 validator 兜底。 |
| `AGENT_SKILL_GRAPH_ROLLOUT` | `guarded` | 仅控制 custom Skill 阶段用哪个执行器：`guarded` 由 V2 typed DAG 执行，`off` 回到 V1 chain（无法识别的取值也按 `off` 处理），`shadow` 仍由 V1 出答案、旁路规划/校验 DAG。DAG 由谁规划跟随 `AGENT_EXECUTION_PLANNER`，LLM 规划失败退回确定性图。V2 候选来自经 `accessScope` / `docIds` 核验、且有显式 typed contract 的已注册原子 Skill catalog，不由 V1 intent/组合 chain 独占；graph 只在执行任何 node 之前整体被拒时才能回落 V1。不会将 built-in/document/Web/capability 阶段纳入同一张 DAG。详见 [agent-rag.md](agent-rag.md#custom-skill-执行v1-chain-与-v2-typed-dag)。 |
| `AGENT_UNIFIED_GRAPH_ROLLOUT` | `off` | 异构 v3 全阶段图目前仅支持 `off` / `shadow`。`shadow` 在注入统一图 planner adapter 时旁路生成并校验候选图，只记录精简的 `unified_graph_planned` run event，真实答案仍走现有外层流程；没有 adapter 会记录 rejected。`guarded` 尚不可选，误设会回到 `off`，不能据此声称生产已执行统一 DAG。 |
| `RAG_PROMPT_VERSION` | `v3` | Prompt 版本；`server/.env.example` 当前显式设置为 `v2`。实际用到的模板以 `id@version#fingerprint` 记录在 LLMOps 事件、`agentObservability.promptTemplates` 和评测报告里（见 `docs/agent-rag.md` 的“Prompt 模板版本”）。 |
| `STARTUP_HEALTH_STRICT` | `false` | 健康检查失败时是否阻止启动。 |

arXiv topic 导入使用公开 Atom API，不需要额外 API key；后端需要能访问 `https://export.arxiv.org/api/query` 和对应 PDF URL。

## Evaluation evidence 配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `EVAL_TARGET_COMMIT_SHA` | 当前 `HEAD` | CI 可显式绑定评测 target SHA；若设置值与 checkout 的 `HEAD` 不一致，runner 会失败而不是生成错误 lineage。 |
| `EVAL_EVIDENCE_PROFILE` | 各 runner 的默认 profile | 写入公开 `evidence.profile`；完整发布 workflow 固定为 `release`。 |

`eval:robust-suite` 会在同一次运行内自行传递 suite ID、run ID 和 config hash，不需要手工设置 suite 环境变量。严格发布 freshness 默认是 `24` 小时，可用 `npm run release:gate -- --max-age-hours <hours>` 临时覆盖；target commit 也可通过 `--target-commit <sha>` 显式指定。完整 CLI 和 lineage 合同见 [evaluation.md](evaluation.md#release-evidence-gate)。

把 Skill graph 设为 `guarded` 只改变运行路径，不等于通过上线门禁。`rollout:readiness` 会同时要求运行环境为 `guarded`、真实模型的 `planner_dynamic_skill_graph` case 通过，以及两次真实 HTTP `/chat` 的 guarded DAG smoke 通过；`release:gate` 还校验同一目标提交的报告 lineage。默认值不会由评测命令自动改成 `guarded`。

## Model/provider registry

`server/rag/model-providers/` 是 provider/model registry 和 runtime route resolver。`server/rag/openai.js` 通过它选择 chat/embedding model name；LLM intent/execution planner 会把公开 `modelRoute` 写入 observability；LLMOps metrics 也复用同一份公开 `modelRoute` 作为 completion/embedding/rerank 的聚合维度；cross-encoder rerank 在 `RAG_CROSS_ENCODER_MODEL` 未显式配置时，可以从 registry route 读取 model name。

默认 registry 从现有变量生成 OpenAI routes：

| Route | Capability | 默认模型来源 |
| --- | --- | --- |
| `chat.default` | `chat` | `OPENAI_CHAT_MODEL` |
| `embedding.default` | `embedding` | `OPENAI_EMBEDDING_MODEL` |
| `planner.intent.default` | `intent_planner` | `OPENAI_CHAT_MODEL` |
| `planner.execution.default` | `execution_planner` | `OPENAI_CHAT_MODEL` |

每个 model contract 记录 stable model id、provider model name、capabilities、latency、pricing 和 workspace policy tags。Route resolution 支持 primary/fallback model，以及 workspace policy 的 allowed/blocked model/provider ids 和 required policy tags。后续接线多 provider 或 fallback 时，应复用这个 registry，而不是在 OpenAI、planner、embedding、rerank 模块各自解析一套模型配置。

公开 `modelRoute` metadata 只包含 route/model/provider id、状态、candidate/fallback/rejected model ids，不包含 API key、secret ref value、transport、prompt、pricing rate 或内部 model name。当前 registry 负责模型选择，LLMOps metric contract 负责把公开 route、latency、status、输入/输出规模、token usage/source、estimated cost/pricing source 和 report-only latency SLO 写入 observability；annotation、alerts 和 budget enforcement 属于后续集成。

## 存储配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `POSTGRES_DATABASE_URL` | 空 | 文档、会话记忆和长期记忆共用连接。 |
| `POSTGRES_SSL_ENABLED` | `false` | PostgreSQL 是否启用 SSL。 |
| `POSTGRES_ROW_LEVEL_SECURITY` | `enforce` | 行级安全。`enforce` 让带访问范围的请求和后台任务在租户角色下执行，数据库拒绝其他租户的行；`off` 保持 owner 连接（策略仍在，但 owner 绕过）。无法识别的值按 `enforce` 处理。`enforce` 下多文档的全文检索通过迁移 014 的 owner 函数排序候选（行级安全下 `@@` 用不上 GIN），函数只拿到租户在文档表里能看到的文档 id，返回的行仍由策略过滤；健康检查会确认租户角色能执行它。 |
| `POSTGRES_TENANT_ROLE` | `archive_rag_tenant` | 行级安全使用的租户角色名（小写标识符）。迁移会创建它，并把它授予应用登录角色。 |
| `DOCUMENTS_POSTGRES_TABLE` | `rag_documents` | 文档表。 |
| `SESSION_MEMORY_POSTGRES_TABLE` | `rag_session_memory` | 会话记忆表。 |
| `LONG_MEMORY_POSTGRES_TABLE` | `long_memory_items` | 长期记忆表。 |
| `RAG_LONG_MEMORY_ENABLED` | PostgreSQL configured -> `true`，否则 `false` | 是否启用长期记忆；显式设为 `false` 会覆盖 PostgreSQL 默认开启。 |
| `RAG_AGENT_EXPERIENCE_MEMORY_ENABLED` | long memory enabled -> `true`，否则 `false` | 是否启用 Agent experience memory；只作为规划提示，不作为文档证据，依赖 long memory。 |
| `TASK_STORE_PROVIDER` | `auto` | task/job 存储；`auto` 在 PostgreSQL 配好时使用 `postgres`，否则使用 `memory`。 |
| `TASKS_POSTGRES_TABLE` | `rag_tasks` | task/job 当前快照表。 |
| `TASK_EVENTS_POSTGRES_TABLE` | `rag_task_events` | task/job 审计事件表。 |
| `AGENT_RUN_STORE_PROVIDER` | `auto` | Agent run 存储；`auto` 在 PostgreSQL 配好时使用 `postgres`，否则使用 `memory`。 |
| `AGENT_RUN_RECOVERY_MODE` | PostgreSQL-backed run store 时为 `auto`，否则 `manual` | Agent run 启动恢复模式；PostgreSQL-backed run store 默认尝试恢复 replay matrix 允许的安全 step，非持久化 run store 默认 `manual`。`document_rag`、`follow_up_retrieval`、`research_question` 都调用真实 `ragService.chat`，都不自动重放，包括旧记录未持久化 replay metadata 的情况。现在只有主 `document_rag` 调用会写会话和长期记忆，另外两类传 `memoryWrites: false`；但注入的 `ragService` 或旧的文档 Skill 不一定遵守这个选项，所以三类 step 的 replay 元数据都保持不变；显式 `manual` 只标记 recoverable run 等待人工处理，`auto` 遇到审批或不安全 step 会回落人工，`off` 跳过启动恢复。失败步骤仍可显式 `retry_failed_step`；重试主 `document_rag` 会再记一次用户的交流，不保证 exactly-once。 |
| `AGENT_RUNS_POSTGRES_TABLE` | `rag_agent_runs` | Agent run 当前快照表。 |
| `AGENT_RUN_EVENTS_POSTGRES_TABLE` | `rag_agent_run_events` | Agent run 审计事件表。 |
| `WORKSPACE_ARTIFACT_STORE_PROVIDER` | `auto` | Workspace artifact 存储；`auto` 在 PostgreSQL 配好时使用 `postgres`，否则回退到 `memory`。 |
| `WORKSPACE_ARTIFACTS_POSTGRES_TABLE` | `rag_workspace_artifacts` | 生成报告、摘要和文档集合 artifact 的持久化表。 |
| `ADMIN_AUDIT_STORE_PROVIDER` | `auto` | Admin audit 存储；`auto` 在 PostgreSQL 配好时使用 append-only PostgreSQL event store，否则使用内存 ring buffer。 |
| `ADMIN_AUDIT_EVENTS_POSTGRES_TABLE` | `rag_admin_audit_events` | Admin authorization audit append-only 事件表。 |
| `ADMIN_AUDIT_RETENTION_DAYS` | `90` | PostgreSQL admin audit retention；设为 `0` 可关闭自动裁剪。 |

Agent experience memory 只进入 planner hints，不进入 citations/evidence。写入策略集中在后端：成功 run 只有在完成、未等待审批/澄清、且有文档证据或 claim support 时才会写入规划经验；负反馈只把 `citation_error`、`hallucination`、`incomplete` 写成严格核验证据的提示；普通 helpful feedback 不写。每个 user/workspace 最多保留 40 条经验，旧记录会在新写入后裁剪。`/chat` 的 `agentObservability.experienceMemory.write` 和 `/feedback` 的 `agentExperienceMemory` 会报告 `status`、`writeAttempted`、`skippedReason`、`storedCount`、`prunedCount` 和已脱敏的 `storedRecords`。

### 数据库行级安全

各个 store 在应用层按 user/workspace 过滤。迁移 `013_enable_tenant_row_level_security.sql` 让 PostgreSQL 也执行同样的规则，这样即使某条查询漏写了过滤条件，也读不到、写不进其他租户的行。

- **覆盖的表**（9 张）：文档、切块、任务、任务事件、Agent run、run 事件、审批快照、workspace artifacts、长期记忆。文档和切块沿用 `documentMatchesAccessScope` 的规则（owner 和 workspace 都为空的行对任何租户不可见）；其余表按 `(user, workspace)` 精确匹配；长期记忆只按用户匹配。
- **不覆盖**：会话记忆（只有 session id，没有 owner 列）；admin audit（workspace 管理员需要跨用户读取，由 admin 权限检查控制）。
- **生效方式**：鉴权之后的中间件把请求的访问范围放进 `AsyncLocalStorage`。`rag/postgres.js` 看到租户时，把这条语句放进一个短事务：`SET LOCAL ROLE` 切到租户角色，并设置 `archive_rag.user_id` / `archive_rag.workspace_id`，事务结束后自动恢复，不会残留在连接池里。
- **后台任务**：任务执行和启动时的 Agent run 恢复，都以该记录自己的范围作为租户。
- **以 owner 身份执行的工作**（`runAsDatabaseSystem`）：迁移、进程级缓存加载（文档 registry）、pgvector 表结构检查和状态统计、跨租户的恢复扫描。
- **不带范围的请求**：鉴权关闭且没有 `x-user-id` / `x-workspace-id` 的请求没有租户，仍以 owner 身份执行，与之前一样。
- **权限要求**：应用登录角色需要 `CREATEROLE`（或由 DBA 预先创建租户角色并授予它）。表的 owner 不受策略约束（`ENABLE`，而不是 `FORCE ROW LEVEL SECURITY`）。
- **新表**：新增的应用表必须在迁移里 `GRANT` 给租户角色；需要隔离的表还要加 `tenant_isolation` 策略。否则租户请求访问它会报权限错误，即失败时拒绝访问。
- **健康检查**：`checks.rowLevelSecurity` 以一个探测租户真实执行一次，确认能切到租户角色、9 张表都带策略；任一条件不满足即报 `error`。

已知边界：

- 租户靠异步上下文传递。如果某个中间件从流回调里继续请求链（例如 multer 的内存存储），上下文会丢失，查询回落到 owner 身份，也就是只剩应用层过滤；上传路由在 multer 之后重新绑定了租户。要做到上下文丢失时也拒绝访问，需要一个没有表权限的独立登录角色，owner 连接只留给显式的系统操作。
- 这层防护针对“漏写过滤条件”这类应用 bug，不防 SQL 注入：注入的语句可以执行 `RESET ROLE`。
- 开启后，租户设置和语句用扩展协议流水线一次往返发出（`rag/postgres.js` 的 `PipelinedQuery`）；用 pg 的 native 绑定时退回 4 次往返（BEGIN、租户设置、语句本身、COMMIT）。

Workspace artifacts 是 agent 生成结果的独立存储层，不进入文档 registry、向量索引或 RAG evidence。PostgreSQL migration `009_create_workspace_artifacts.sql` 为 `userId/workspaceId/idempotencyKey` 建立唯一约束；memory provider 只适合本地开发，进程重启后数据会丢失。单个 artifact 限制为：正文 512 KiB、结构化 payload 256 KiB、100 条 citation manifest、500 个 docIds；列表接口默认返回 50 条，最大 100 条。

### 读副本

默认关闭。不设 `POSTGRES_READ_REPLICA_URLS` 时什么都不变，所有语句都在主库执行。怎么起一个副本、怎么验证，见 [deployment.md](deployment.md#读副本可选)。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `POSTGRES_READ_REPLICA_URLS` | 空 | 读副本地址，逗号分隔，`postgres://` 或 `postgresql://`。必须是同一个数据库的流复制热备（hot standby）。按位置编号为 `replica-0`、`replica-1`……；健康检查和指标里只显示 host:port，不显示地址本身（里面可能有密码）。任一条无效，或者只写了逗号、没有地址时，所有标记为只读的语句直接报错，`checks.readReplicas` 报 `error`，不会悄悄退回主库。 |
| `POSTGRES_READ_REPLICA_MAX_LAG_MS` | `2000` | 副本延迟超过这个值就不用它（整数，≥ 0）。 |
| `POSTGRES_READ_REPLICA_LAG_POLL_MS` | `500` | 测延迟的轮询间隔（≥ 10）。 |
| `POSTGRES_READ_REPLICA_POOL_MAX` | `10` | 每个副本的读连接池大小；在途读满了就跳过这个副本。 |
| `POSTGRES_READ_REPLICA_CONNECT_TIMEOUT_MS` | `2000` | 连副本的超时，也是延迟监控每次轮询的超时。 |
| `POSTGRES_READ_REPLICA_CIRCUIT_FAILURE_THRESHOLD` | `3` | 连续几次"不可用"错误后打开这个副本的熔断。 |
| `POSTGRES_READ_REPLICA_CIRCUIT_COOLDOWN_MS` | `5000` | 熔断打开多久后放一次探测请求。 |

数值变量必须是整数且不小于下限，否则和无效地址一样报错。测试专用：`PGVECTOR_TEST_REPLICA_URL`（与 `PGVECTOR_TEST_DATABASE_URL` 一起，超级用户）打开 `test/postgres-replica.integration.test.mjs`，缺一个就跳过。

- **哪些读会去副本**：只有同时满足三个条件的语句：调用方明确标记为只读；在生效的租户下执行（走租户流水线，所以副本上的行级安全就是主库重放过来的同一套策略）；不在 `withPostgresTransaction` 里。目前只有 pgvector 的稠密检索（含迭代扫描，这时 `set_config` 作为同一次往返的前置语句，不再开事务）和稀疏检索（BM25 / 剪枝函数、`ts_rank_cd` 租户函数、普通语句）会标记，而且只在没有传入调用方连接、并且本进程的文档注册表认识每一个被检索文档时才标记。
- **一直留在主库的**：写入、迁移、`LISTEN`、advisory lock、索引版本指针、所有 owner/system 语句、文档注册表的加载和刷新、`GET /documents`、`GET /documents/:id/file`、run 和任务的读接口。没有访问范围的请求（鉴权关闭且不带 `x-user-id` / `x-workspace-id`）和 `POSTGRES_ROW_LEVEL_SECURITY=off` 时，语句都是 owner 身份，配了副本也不会分流，健康检查也不会提示这一点。
- **一致性**：
  - 新鲜度 guard：和检索在同一次往返里先在副本上执行。它要求副本上每个被检索文档的 `content_version` 不低于本进程注册表从主库读到的版本，索引指针的 generation 不低于这次检索所用版本的 generation。不满足时副本跳过这条语句，改由主库回答，计为 `version_behind`。这依赖 pgvector 的写入、替换和删除都把文档行和分块放在同一个事务里提交。
  - 锚点：每次 `/chat` 和任务开始前，先从主库刷新这个租户的注册表；刷新失败时，这次请求的所有读都走主库（计为绕过原因 `registry_unverified`）。拆分部署下，开启副本时检索层会从主库重读请求里的每个 docId。
  - 有界陈旧度：监控按 `POSTGRES_READ_REPLICA_LAG_POLL_MS` 采样主库的 flush LSN 和每个副本的重放 LSN，延迟取"副本已重放过的最新主库样本"的年龄。测不出延迟的副本不用。主库 LSN 倒退（主备切换）时重新采样。
- **回退**：副本延迟超限、不可达、不在 recovery、熔断打开、在途读满，都跳过；副本上任何错误都回退主库并按原因计数，请求本身不会因为副本失败。多个副本时选在途读最少的，相同时轮流。
- **健康检查**：只有设置了这个变量、并且本进程承载检索层（`retrieval` 角色，或没设 `RETRIEVAL_SERVICE_URL` 的 `all`）时，才出现 `checks.readReplicas`。副本延迟、宕机、熔断最多报 `warning`，`/ready` 仍是 200；只有配置无效才报 `error`。

已知边界：

- 副本上的语句只有连接超时，没有语句超时，也不受请求截止时间限制。已建立的连接被黑洞时，在途的读会一直等到 TCP keepalive 发现；监控会把副本标成不可达，新的读不再选它。
- 副本上的 BM25 用的是副本当时的按租户统计；guard 只证明被检索的文档是新的，同一租户其他文档的写入可能还没重放，分数可能和主库略有差异（在延迟上限以内）。
- `vector:reindex --apply` 原地重写分块但不升 `content_version`，重建期间落后的副本可能对重新向量化的文档返回空的稠密结果，直到追上（受延迟上限约束，不受 guard 约束）。
- `/chat` 开始时的注册表刷新如果失败，只打日志，这次请求的 guard 可能用的是旧版本。
- 不检查副本是否真的跟随这个主库（`system_identifier`）。误配成别的集群的备库时，带 guard 的读会因为找不到文档而回退，不会读错数据，但会被计为 `version_behind`。
- 延迟计算假设 `synchronous_commit` 是 `on`。

## 上传入库

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RAG_INGEST_MODE` | `sync` | `sync`：上传请求里完成解析、向量化和写索引，返回 201 和文档（原有行为）。`async`：只做原有校验（PDF 魔数、大小、分片会话），把文件字节存进入库任务，返回 202 `{jobId, docId, fileName, status: "queued"}`，由 worker 执行同一个 `ingestDocument`。无法识别的值按 `sync` 处理。 |
| `RAG_INGEST_WORKER_ENABLED` | `true` | `async` 下 API 进程是否同时运行 worker。设为 `false` 时入库交给 `npm run worker:ingest` 进程。没有 PostgreSQL（队列在内存里）或向量库是 `local` 时忽略 `false`，并打印错误。 |
| `RAG_INGEST_WORKER_CONCURRENCY` | `2` | 每个进程同时处理的任务数。 |
| `RAG_INGEST_WORKER_POLL_MS` | `1000` | 空闲 worker 两次查看队列的最长间隔。任务入队或被归还时会立即唤醒：同一进程内直接唤醒，其他进程通过 PostgreSQL `LISTEN/NOTIFY`。这个间隔只是兜底，唤醒丢失时（LISTEN 连接断开、重试退避到期、租约过期）最多晚一个间隔领取。 |
| `RAG_INGEST_JOB_LEASE_MS` | `60000` | 任务租约。运行期间约每三分之一租约续一次；进程停止续约、租约过期后，下一个 worker 接手，尝试次数加一。 |
| `RAG_INGEST_JOB_MAX_ATTEMPTS` | `3` | 最多尝试次数。408/409/425/429、5xx 和网络错误按 5 s、10 s、20 s……（上限 5 分钟，且不短于 Retry-After）重新排队；其他 4xx（如 422"PDF 中没有可提取的文字"）直接失败。 |
| `RAG_INGEST_MAX_PENDING_JOBS_PER_TENANT` / `RAG_INGEST_MAX_PENDING_BYTES_PER_TENANT` | `50` / 1 GiB | 每个租户排队中和运行中的任务上限，超出时上传返回 429；0 表示不限。检查和插入是同一条语句，并发上传可能略微超出。 |
| `RAG_INGEST_JOB_RETENTION_MS` | 7 天 | 已完成任务的保留时长，由 worker 空闲时清理；0 永久保留。 |
| `INGEST_JOBS_POSTGRES_TABLE` | `rag_ingest_jobs` | 任务表名（迁移 015）。 |

- 任务状态：`GET /ingest-jobs/:jobId` 返回 `{jobId, docId, fileName, status, attemptCount, error, createdAt, startedAt, finishedAt}`，成功时带上与 201 相同的 `document`。`status` 为 `queued`、`running`、`succeeded` 或 `failed`。`error` 只给入库对上传本身的错误（413/415/422），其他错误统一为 "Indexing failed on the server."，完整错误只写 worker 日志。按 access scope 过滤，查别的租户的任务返回 404。
- 任务表启用行级安全，策略与 `rag_documents` 相同，计入 `/health` 的 `checks.rowLevelSecurity`。
- worker 以数据库 owner 身份领取任务：一条 `UPDATE ... FOR UPDATE SKIP LOCKED`，先选当前运行任务最少的租户，再按创建时间；领取后以任务所属租户的身份入库。之后的续约、成功、失败和归还都以 `job_id + claimed_by + attempt_count` 为条件，失去租约的 worker 覆盖不了新一次尝试。
- 重试前由数据库判定文档是否已提交（不信任本进程的注册表缓存）：上一次尝试已写入文档行和分块、但没来得及标记成功时，重试直接记为成功，不会重复入库。前一次尝试持有租约时进程死掉的任务会单独运行，避免一个让进程崩溃的 PDF 耗掉同批其他任务的尝试次数。
- 任务结束后 `file_bytes` 置空；每次尝试的临时 PDF 写在上传目录的 `ingest-tmp/` 下，续租时刷新修改时间，超过两倍租期没刷新的由清理删除。
- 入队唤醒：入队语句本身调用 `pg_notify('<任务表名>_enqueued', <实例 id>)`，事务提交时才发出；被上限拒绝（429）的上传不发。通知只含随机实例 id，不含任务信息。每个运行 worker 的进程持有一个专用 LISTEN 连接：不走连接池、以 owner 身份、开启 TCP keepalive，后台建立、不阻塞启动，断开后按 0.5 s 起、上限 30 s 退避重连，重连后主动查一次队列。经过 PgBouncer 事务池时收不到通知，只能靠轮询。
- 跨实例文档可见性：文档注册表在 PostgreSQL 时（默认），不论 `sync` 还是 `async`，API 实例按 docId 查不到或要删除文档时先从数据库按 id 重读，`GET /documents` 和每个 `/chat` 开头先按请求租户重读文档表；同一租户的并发请求共用一次查询，但只共用在它们到达之后才开始的那次。别的实例上传或删除的文档因此在这里立即可见，清空文档以数据库实际删除的行为准。重读不会覆盖本进程事务中尚未提交的入库、删除或清空。文件注册表（standalone）和内存注册表不做这些读取。
- 前端收到 202 后轮询任务状态，间隔从 1 秒增长到 5 秒，最多 10 分钟；网络错误、429、5xx 继续轮询（遵守 Retry-After），只有任务 `failed` 或 404 才判定失败。

## Vector store

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `VECTOR_STORE_PROVIDER` | `pgvector` | 严格白名单：`pgvector`（默认，chunk 与向量存在 PostgreSQL）、`local`（本地 JSON 索引，显式 opt-in）、`qdrant`（显式 opt-in）。其他值在启动健康检查、ingest 和检索时都直接报错，不会静默回落到 `local`。 |
| `DOCUMENT_CHUNKS_POSTGRES_TABLE` | `rag_document_chunks` | pgvector chunk/向量表；外键级联到 `DOCUMENTS_POSTGRES_TABLE`。 |
| `RAG_EMBEDDING_DIMENSIONS` | 由模型推导 | pgvector 列宽。留空时按 `OPENAI_EMBEDDING_MODEL` 推导（`text-embedding-3-small`=1536、`-large`=3072、`ada-002`=1536，未知模型 1536）。列宽或模型与库中已有 chunk 不一致时 ingest/检索明确失败并要求 `npm run vector:reindex`。 |
| `RAG_PGVECTOR_TEXT_SEARCH_CONFIG` | `simple` | 稀疏路（PostgreSQL FTS）使用的 text search configuration。chunk 文本先用应用内 tokenizer 切分（CJK 逐字、ASCII 小写去停用词）再建 tsvector，因此默认 `simple`。排序用 `ts_rank_cd`，不是 BM25。 |
| `RAG_PGVECTOR_INDEX_TYPE` | `hnsw` | `hnsw` 或 `ivfflat`，都用 cosine 距离。 |
| `RAG_PGVECTOR_HNSW_M` / `RAG_PGVECTOR_HNSW_EF_CONSTRUCTION` | `16` / `64` | HNSW 建索引参数。 |
| `RAG_PGVECTOR_ITERATIVE_SCAN` | `relaxed_order` | 稠密检索对每次查询设置的 pgvector 迭代扫描模式：`relaxed_order`、`strict_order` 或 `off`。文档过滤在 HNSW 取回 `ef_search` 个候选之后才生效，所以不开迭代扫描时，走 HNSW 的过滤查询可能返回不满 topK 条；打开后会继续扫描索引，直到凑满 LIMIT 或达到 `hnsw.max_scan_tuples`（默认 20000）。`relaxed_order` 的输出顺序由外层 SQL 重新排好。设置和查询在同一个短事务里执行，每次查询多一次往返。需要 pgvector 0.8 以上，更老的版本自动保持原来的 SQL；IVFFlat 索引用 `ivfflat.iterative_scan`。`off` 是回退开关。 |
| `RAG_PGVECTOR_IVFFLAT_LISTS` | `100` | IVFFlat `lists`。 |
| `QDRANT_URL` | `http://127.0.0.1:6333` | Qdrant 地址。 |
| `QDRANT_API_KEY` | 空 | Qdrant API key。 |
| `QDRANT_COLLECTION` | `rag_chunks` | Qdrant collection 名称。 |
| `QDRANT_DISTANCE` | `Cosine` | Qdrant 向量距离。 |

`local` provider 会把 dense vector index 写到 `server/data/rag/vector-index.json`，本地 sparse index 写到 `server/data/rag/sparse-index.json`。

## Retrieval 配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RAG_CHUNK_STRATEGY` | `structured` | `structured` 或 `simple`。 |
| `RAG_CHUNK_SIZE` | `900` | Chunk 最大长度。 |
| `RAG_CHUNK_OVERLAP` | `180` | Chunk overlap。 |
| `RAG_RETRIEVAL_TOP_K` | `6` | QA 路径召回数量。 |
| `RAG_COMPARE_TOP_K_PER_DOC` | `3` | Compare 路径每份文档保留证据数。 |
| `RAG_QUERY_DECOMPOSITION_ENABLED` | `true` | 是否拆分复杂 evidence requirements。 |
| `RAG_QUERY_DECOMPOSITION_MAX_REQUIREMENTS` | `4` | 单次最多拆分需求数。 |
| `RAG_MIN_RELEVANCE_SCORE` | `0.32` | 置信度门控最低相关分。 |
| `RAG_MIN_QUERY_TERM_COVERAGE` | `0.51` | Query term coverage 门槛。 |
| `RAG_NEAR_DUPLICATE_GUARD_ENABLED` | `true` | 近重复且无冲突时避免编造差异。 |

## Hybrid 和 rerank

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RAG_HYBRID_ENABLED` | `true` | 文档 RAG 默认真正跑两路召回：dense（pgvector cosine / local / qdrant）与 sparse（PostgreSQL FTS / local BM25 / qdrant sparse）各自独立检索后融合。设为 `false` 只跑 dense 一路，这是 opt-out。 |
| `RAG_HYBRID_FUSION` | `rrf` | `rrf`（默认，RRF 分数按 `(k+1)` 归一到 0–1 以匹配 `RAG_MIN_RELEVANCE_SCORE`）或 `weighted`。rerank 始终在 fusion 之后。 |
| `RAG_HYBRID_DENSE_WEIGHT` | `0.65` | Weighted fusion 的 dense 权重。 |
| `RAG_HYBRID_SPARSE_WEIGHT` | `0.35` | Weighted fusion 的 sparse 权重。 |
| `RAG_RRF_K` | `60` | RRF 平滑常数。 |
| `RAG_RERANK_ENABLED` | `false` | 是否启用 rerank。 |
| `RAG_RERANK_PROVIDER` | `heuristic` | `heuristic`、`cross-encoder` 或代码内注入的 `custom`。启发式重排在 QASPER 上没有收益。有重排服务时推荐 `cross-encoder` 加 BAAI/bge-reranker-v2-m3：dev 上证据进入模型上下文 +0.063，可回答题的拒答率下降 4.4 个百分点，不可回答题识别率不变（见 evaluation.md 的“交叉编码器重排”）。重排服务不可用时，该次查询退回融合排序并打印警告，不会失败。 |
| `RAG_RERANK_CANDIDATE_MULTIPLIER` | `3` | Rerank 候选放大倍数。 |
| `RAG_RERANK_WEIGHT` | `0.6` | Rerank 分数与粗排分数混合权重。 |
| `RAG_CROSS_ENCODER_ENDPOINT` | 空 | Cross-encoder HTTP endpoint，请求 `{query, texts}`、返回 `{scores}`，和 Hugging Face TEI 的 `/rerank` 格式相同。本地用 `npm run rerank:cross-encoder` 启动，地址是 `http://127.0.0.1:8081/rerank`。 |
| `RAG_QA_MIN_RERANK_PROBABILITY` | `0.02` | 开启交叉编码器重排后，单文档问答是否作答，由重排模型给出的相关概率决定，不再看问题词覆盖率。只对带重排分数的结果生效：没开重排或重排失败时，仍用词面门控。设为 `off` 可关闭。0.02 是在 QASPER train 上按事先定的代价规则选出的。dev 上可回答题被拒答从 37.8% 降到 13.9%，F1 不变；但不可回答题的识别率从 80% 降到 45%（见 evaluation.md 的"重排概率做拒答门控"）。 |
| `RAG_CROSS_ENCODER_SCORES` | `logits` | 重排服务返回的分数格式：`logits`（本仓库的端点）或 `probabilities`（Hugging Face TEI 的默认）。拒答门控会把它换算成概率。 |
| `RAG_CROSS_ENCODER_MODEL` | 空 | 传给 cross-encoder endpoint 的可选模型名。 |

## Auth 和 access scope

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `API_AUTH_ENABLED` | `false` | 是否启用 API token 鉴权。 |
| `API_AUTH_TOKEN` | 空 | 单用户/本地开发 token。 |
| `API_AUTH_TOKENS` | 空 | 多用户 token 映射。 |
| `API_AUTH_REQUIRE_WORKSPACE` | `false` | 鉴权请求是否必须解析出 workspace scope；多租户部署建议设为 `true`。 |
| `API_AUTH_JWT_ENABLED` | `false` | 是否允许 `Authorization: Bearer <jwt>` 走 HS256 JWT 验证。静态 token 仍优先匹配。 |
| `API_AUTH_JWT_HS256_SECRET` / `API_AUTH_JWT_SECRET` | 空 | JWT HS256 secret；`API_AUTH_JWT_ENABLED=true` 时必须配置。 |
| `API_AUTH_JWT_ISSUER` | 空 | 可选 issuer 校验，对应 JWT `iss`。 |
| `API_AUTH_JWT_AUDIENCE` | 空 | 可选 audience 校验，对应 JWT `aud`。 |
| `API_AUTH_JWT_USER_CLAIM` | `sub` | 映射为 `accessScope.userId` 的 claim path。支持点号路径。 |
| `API_AUTH_JWT_WORKSPACE_CLAIM` | `workspace_id` | 映射为固定 `accessScope.workspaceId` 的 claim path。 |
| `API_AUTH_JWT_WORKSPACES_CLAIM` | `workspaces` | 映射为允许 workspace 列表的 claim path；请求 workspace 必须落在该列表内。 |
| `API_AUTH_JWT_ROLES_CLAIM` | `roles` | 映射为 admin role IDs 的 claim path。 |
| `API_AUTH_JWT_PERMISSIONS_CLAIM` | `permissions` | 映射为 admin permission IDs 的 claim path。 |
| `API_AUTH_REVOKED_TOKEN_HASHES` | 空 | 逗号分隔的 JWT SHA-256 token hash 撤销列表。 |
| `API_AUTH_REVOKED_JTIS` | 空 | 逗号分隔的 JWT `jti` 撤销列表。 |

多人部署可以继续使用 `API_AUTH_TOKENS`：

```env
API_AUTH_ENABLED=true
API_AUTH_REQUIRE_WORKSPACE=true
API_AUTH_TOKENS={"alice-token":{"userId":"alice","workspaceId":"workspace-a"},"ops-token":{"userId":"ops","allowedWorkspaceIds":["workspace-a","workspace-b"]}}
```

也可以接入外部身份服务签发的 HS256 JWT：

```env
API_AUTH_ENABLED=true
API_AUTH_REQUIRE_WORKSPACE=true
API_AUTH_JWT_ENABLED=true
API_AUTH_JWT_HS256_SECRET=replace-with-issuer-secret
API_AUTH_JWT_ISSUER=https://issuer.example
API_AUTH_JWT_AUDIENCE=archive-rag
```

启用带 `userId/workspaceId` 的 principal 后，文档列表、chat、删除和 PDF 文件流都会按访问范围过滤。使用 PostgreSQL 时，数据库行级安全会再检查一遍（见下文“数据库行级安全”）。`workspaceId` / `workspace_id` 表示固定 workspace；`allowedWorkspaceIds` 或 JWT `workspaces` 表示允许的 workspace 列表，请求里的 `x-workspace-id` / `workspaceId` 必须落在该列表内。旧的无 scope 文档不会出现在 scoped 用户视图中，需要重新上传或迁移 owner/workspace 元数据。

请求里能不能自己指定用户（header `x-user-id`，或 body / query 里的 `x-user-id` / `userId`），取决于凭证：

- 凭证自带 `userId`（带 `userId` 的 `API_AUTH_TOKENS` 条目、HS256 JWT、OIDC）：始终按这个用户处理，请求里的 userId 会被忽略。
- 不开鉴权、单个 `API_AUTH_TOKEN`、或者 `API_AUTH_TOKENS` 条目写了 `"allowClientUserId": true`：按请求里的 userId 处理，和以前一样。只认 JSON 的 `true`，字符串 `"true"` 不算。
- 其他不带 `userId` 的凭证（例如只写了 `workspaceId` 的 `API_AUTH_TOKENS` 条目）：不代表任何用户；请求里一旦写了非空的 userId，就返回 403。唯一的例外是 `GET /admin/audit` 的 `userId` 查询参数，它是筛选条件。

这是一个不兼容的变化：以前不带 `userId` 的 token 条目可以用 `x-user-id` 冒充任何用户，读写、删除他的文档和长期记忆。依赖这种用法的部署，要给条目加上 `userId`，或者明确写 `"allowClientUserId": true`。前端每次 `/chat` 都会在 body 里带一个本地生成的 `userId`，所以和前端一起用的条目必须是这两种之一：

```env
API_AUTH_TOKENS={"shared-token":{"workspaceId":"workspace-a","allowClientUserId":true}}
```

Admin 端点还会读取 token principal 或 JWT claims 上的 `roles` / `roleIds` 和 `permissions` / `permissionIds`。内置角色包括 `admin.viewer`、`admin.quality_operator`、`admin.recovery_operator`、`admin.operator`、`admin.owner`；也可以直接授予 `admin.status.read`、`admin.audit.read`、`admin.actions.recovery_scan`、`admin.actions.quality_refresh`、`admin.actions.recover_tasks` 等权限：

```env
API_AUTH_TOKENS={"admin-token":{"userId":"admin","workspaceId":"workspace-a","roles":["admin.operator"]}}
```

`GET /admin/audit` 默认只返回当前 token workspace 下的 compact authorization events；支持 `limit`、`offset`、`userId`、`workspaceId`、`actionId`、`permissionId`、`result=allowed|denied`、`from` 和 `to` 查询参数。事件只包含 compact principal、request 和 authorization decision，不保存 token、payload、prompt 或 raw trace。

### OIDC

`API_AUTH_OIDC_ENABLED=true`（需要同时 `API_AUTH_ENABLED=true`）让 `requireApiAuth` 接受外部 IdP 签发的 access token（`Authorization: Bearer`，也可以放在 `x-api-key`）。不设置时行为与之前完全一致。分流规则：静态 token 先匹配；OIDC 开启时，`API_AUTH_JWT_ENABLED` 开着的情况下 HS* JWT 仍走 HS256 校验器，其余 JWS 一律走 OIDC（OIDC 拒绝 HS*/none）。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `API_AUTH_OIDC_ENABLED` | `false` | 是否接受 OIDC access token。 |
| `API_AUTH_OIDC_ISSUER` | 空 | 启用时必填。必须与 discovery 文档的 `issuer` 完全一致；https，只有 loopback 主机允许 http。缺失时配置状态为 error，API 返回 500。 |
| `API_AUTH_OIDC_AUDIENCE` | 空 | 启用时必填。token 的 `aud` 必须包含它。请用 API 自己的 audience，不要填 SPA 的 client id（否则 ID token 也能当 access token 用，除非 `API_AUTH_OIDC_REQUIRE_TYP=true`）。 |
| `API_AUTH_OIDC_CLIENT_ID` | 空 | 非空时 token 的 `azp`（或 `client_id`）必须等于它；也通过 `GET /auth/config` 告诉 SPA。Okta 的 `cid`、Azure v1 的 `appid` 不被接受。 |
| `API_AUTH_OIDC_SCOPES` | `openid profile email` | 只展示给 SPA。 |
| `API_AUTH_OIDC_ALGORITHMS` | `RS256,PS256,ES256,EdDSA` | 允许的签名算法；其他值被忽略，有效列表为空时返回 500。alg 必须与 JWK 的 kty/crv（以及 JWK 自带的 alg）一致，RSA 密钥至少 2048 位，带 `crit` 头的 token 被拒绝。 |
| `API_AUTH_OIDC_CLOCK_SKEW_SEC` | `60` | `exp`/`nbf`/`iat` 的时钟偏差，最大 600。`exp` 必须存在。 |
| `API_AUTH_OIDC_JWKS_TTL_MS` | `600000` | discovery 和 JWKS 的缓存时间。从 JWKS 删除的密钥最多在一个 TTL 内失效。 |
| `API_AUTH_OIDC_JWKS_MIN_REFRESH_MS` | `30000` | 遇到未知 `kid` 时最多每个窗口刷新一次 JWKS（并发请求共用同一次刷新），防止伪造 kid 打爆 IdP。0 关闭限速，不建议。 |
| `API_AUTH_OIDC_HTTP_TIMEOUT_MS` | `5000` | 拉取 discovery/JWKS 的超时。IdP 不可达时继续用上一份可用密钥；一份都没有时返回 503。 |
| `API_AUTH_OIDC_REQUIRE_TYP` | `false` | 为 `true` 时 token 头的 `typ` 必须是 `at+jwt` 或 `application/at+jwt`。 |
| `API_AUTH_OIDC_USER_CLAIM` | `sub` | 映射为 `accessScope.userId`。所有 claim 名都支持点号路径。 |
| `API_AUTH_OIDC_WORKSPACE_CLAIM` | `workspace_id` | 固定 workspace。 |
| `API_AUTH_OIDC_WORKSPACES_CLAIM` | `workspaces` | 允许的 workspace 列表，`x-workspace-id` 必须落在其中。没有 workspaces 也没有 workspace_id 的 token 可以通过 `x-workspace-id` 选任意 workspace，所以生产环境应让 IdP 为每个用户签发该 claim。 |
| `API_AUTH_OIDC_ROLES_CLAIM` | `roles` | 全局角色（例如 Keycloak 的 `realm_access.roles`）。 |
| `API_AUTH_OIDC_GROUPS_CLAIM` | `groups` | 组 claim，经 `API_AUTH_OIDC_GROUP_ROLE_MAP` 映射成角色后并入 roles。 |
| `API_AUTH_OIDC_GROUP_ROLE_MAP` | 空 | JSON `{"group": "role" \| ["role", ...]}`；非法 JSON 返回 500。组名区分大小写。 |
| `API_AUTH_OIDC_PERMISSIONS_CLAIM` | `permissions` | 直接授予的权限 id。 |
| `API_AUTH_OIDC_WORKSPACE_ROLES_CLAIM` | `workspace_roles` | 按 workspace 授予的角色：对象 `{"ws": ["role"] \| "a,b"}` 或数组 `[{"workspaceId": "ws", "roles": [...]}]`。静态 `API_AUTH_TOKENS` 条目也可以写 `workspaceRoles` / `workspace_roles`。 |

`API_AUTH_REVOKED_JTIS` 和 `API_AUTH_REVOKED_TOKEN_HASHES` 同样适用于 OIDC token。失败统一返回 401 `{"error":"Unauthorized."}`、503 `{"error":"OIDC provider is unavailable."}` 或配置错误时的 500，响应体从不包含 token。

`GET /auth/config`（公开，`Cache-Control: no-store`，在限流和鉴权之前）返回 `{mode, oidc}`：`mode` 为 `disabled`（auth 关闭）、`token`（auth 开、OIDC 关）或 `oidc`；`oidc` 只在启用时为 `{issuer, clientId, scopes, audience}`，不含任何密钥。

开发用 IdP（`npm run oidc:dev`，即 `server/dev-oidc-provider.mjs`，只用于开发和测试）读取这些变量：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DEV_OIDC_PORT` | `5556` | 监听端口（只绑定 127.0.0.1），也可用 `--port`。 |
| `DEV_OIDC_USERS_FILE` | 空（内置 alice/bob/carol） | 用户 JSON 数组 `[{sub, name?, email?, username?, claims: {workspace_id, workspaces, roles, groups, permissions, workspace_roles}}]`，也可用 `--users`。 |
| `DEV_OIDC_CLIENT_ID` | `archive-rag-spa` | 唯一登记的 public client。 |
| `DEV_OIDC_AUDIENCE` | `archive-rag-api` | access token 的 `aud`。 |
| `DEV_OIDC_REDIRECT_URIS` | 空（任意 loopback http(s) URI） | 逗号分隔的允许回调地址。 |
| `DEV_OIDC_ACCESS_TOKEN_TTL_SEC` | `600` | access token 有效期。 |

### RBAC

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RBAC_MODE` | `off` | `off` 不改变任何行为；`enforce` 时每个路由都要有 `RBAC_ROUTE_TABLE` 里声明的权限，不在表里的路由一律 403。其他值拒绝启动。 |
| `RBAC_DEFAULT_ROLE` | `workspace.member` | 主体在当前 workspace 没有任何 workspace 权限时补上的角色，让开启 enforce 后的现有静态 token 用户继续可用；它不会抬高显式授予的角色（例如 viewer）。`none` 关闭。必须是策略里存在的角色。OIDC 部署建议在所有用户都有角色后设为 `none`。 |
| `RBAC_POLICY_JSON` | 空 | 覆盖或新增角色：`{"roles":{"<role>":["perm",...]}}`、扁平 `{"<role>":[...]}` 或 `{"<role>":{"permissions":[...]}}`。未知权限 id 或非法 JSON 拒绝启动。 |
| `RBAC_POLICY_FILE` | 空 | 同上，从文件读取；与 `RBAC_POLICY_JSON` 只能设一个。 |

权限：`documents.read`、`documents.write`、`documents.delete`、`chat.ask`、`tasks.run`、`memory.read`、`memory.write`、`quality.feedback`，加上全部 `admin.*` 权限（`admin.status.read`、`admin.audit.read`、`admin.actions.*`、`agent_runs.recovery.action`、`agent_tasks.action`）。角色：`workspace.viewer`（read、chat）、`workspace.member`（再加 write、tasks、memory、feedback）、`workspace.admin`（再加 delete；作为全局角色时还有 `admin.status.read`），以及原有的 `admin.viewer`、`admin.quality_operator`、`admin.recovery_operator`、`admin.operator`、`admin.owner`（全部权限）。

有效权限 = 全局 roles/permissions 的权限 ∪ 当前 workspace 的 `workspaceRoles` 的权限（只取 workspace 类权限，`admin.*` 只能来自全局角色或权限）∪ 默认角色（仅在前两者没有任何 workspace 权限时）。RBAC 只决定能做什么动作，不改变文档可见性：文档仍按 owner/workspace 过滤。`GET /auth/me` 返回 `{userId, workspaceId, workspaceIds, roles, permissions, authProvider, rbacMode}`（当前 workspace 的有效权限，`no-store`，不含 token）。拒绝时返回 403 `{"code":"RBAC_PERMISSION_DENIED","error":"Forbidden.","permission":<id>|null}`，并写入 admin audit（只含 id）。

本地开发示例：

```env
API_AUTH_ENABLED=true
API_AUTH_OIDC_ENABLED=true
API_AUTH_OIDC_ISSUER=http://127.0.0.1:5556
API_AUTH_OIDC_AUDIENCE=archive-rag-api
API_AUTH_OIDC_CLIENT_ID=archive-rag-spa
API_AUTH_OIDC_REQUIRE_TYP=true
RBAC_MODE=enforce
```

## 拆分部署

默认不需要设置下面任何一项：不设 `ARCHIVE_RAG_ROLE`、也不设三个服务地址时，进程就是原来的单体。怎么跑拆分部署见 [deployment.md](deployment.md#拆分部署可选)。

### 角色和服务地址

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `ARCHIVE_RAG_ROLE` | `all` | 这个进程跑哪一层：`all`（单体）、`api`（公网入口）、`agent`（Agent 编排）、`retrieval`（检索）、`model-gateway`（模型网关）。忽略大小写和首尾空格；其他值在启动时直接报错，不会退回单体。 |
| `AGENT_SERVICE_URL` | 空 | agent 层的副本地址，逗号分隔。设置后，`/chat`、`/chat/stream`、任务、触发器、agent run 及其操作、`/capabilities` 和 `POST /admin/actions/:action` 转发到 agent 层。`api` 角色必须设置。 |
| `RETRIEVAL_SERVICE_URL` | 空 | 检索层的副本地址，逗号分隔。设置后，文档问答和对比的检索（查询 embedding、稠密 + 稀疏、融合、重排）交给检索层，本进程不再读分块表。`agent` 角色不设时在本进程检索，启动时打印警告。 |
| `MODEL_GATEWAY_URL` | 空 | 模型网关的副本地址，逗号分隔。设置后，chat、embedding 和交叉编码器重排都经网关调用；配置了自定义 provider 的调用仍在本进程执行。 |

- 地址只能是 http 或 https，不能带用户名密码、查询串或 `#`；可以带路径前缀，末尾的 `/` 会去掉，重复的地址只保留一个。任一条无效时启动报错。
- 每一层都不会调用自己：`agent` 角色忽略 `AGENT_SERVICE_URL`，`retrieval` 忽略 `RETRIEVAL_SERVICE_URL`，`model-gateway` 忽略 `MODEL_GATEWAY_URL`，并各打印一条警告。所以同一份环境变量可以发给所有角色。
- `all` 角色设置了哪个地址，就把哪部分工作交出去。例如只设 `MODEL_GATEWAY_URL`，就是"单体 + 独立模型网关"。

### 内部身份

层与层之间的调用带一个短期签名 token（`x-archive-service-token` 头），audience 是目标层，issuer 是调用方的角色，租户（userId、workspaceId）只从 token 里读，请求体里的租户字段一律不认。公网入口在读任何请求头之前，先删掉所有 `x-archive-service-` 开头的头。签名方式由 `INTERNAL_SERVICE_AUTH` 决定：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `INTERNAL_SERVICE_AUTH` | `hmac` | `hmac`：所有层共用 `INTERNAL_SERVICE_KEYS` 做 HS256 签名（原来的方式）。`ed25519`：每个进程只持有自己的 Ed25519 私钥，用登记在 issuer 名下的公钥验证，HS256 token 一律拒绝。`mixed`：用 Ed25519 签名，同时接受两种 token，只用于从 `hmac` 滚动切换到 `ed25519` 的过渡。其他值启动报错，所有签名和校验也都报错，不会退回别的方式。 |
| `INTERNAL_SERVICE_KEYS` | 空 | `hmac` 和 `mixed` 用的 HMAC 密钥，格式 `kid1:secret1,kid2:secret2`。kid 由字母、数字、`.`、`_`、`-` 组成，最长 64；密钥是第一个冒号之后的全部内容，至少 32 个字符，不能含逗号。第一个密钥签名，所有密钥都能验证。`hmac` 下，除 `all` 以外的角色、以及设置了任一服务地址的进程都必须配置，而且所有层要用同一份；`mixed` 下被调用的层也必须配置，用来验证还没切换的调用方。 |
| `INTERNAL_SERVICE_SIGNING_KEY` | 空 | `ed25519` / `mixed` 下本进程的 Ed25519 私钥：PKCS8 PEM（可以用字面的 `\n` 换行）或 base64 DER。凡是会调用别的层的进程（设了任一服务地址的进程，例如 api、agent，以及设了 `MODEL_GATEWAY_URL` 的 retrieval 和 `all`）都必须配置；模型网关不调用别人，不需要。只发给这一个进程。 |
| `INTERNAL_SERVICE_SIGNING_KEY_ID` | 公钥指纹 | 私钥的 kid，默认 `ed25519-` 加公钥 SPKI 的 SHA-256 前 20 个十六进制字符。 |
| `INTERNAL_SERVICE_TRUSTED_KEYS` | 空 | 受信公钥列表，格式 `issuer:kid:base64spki,...`；issuer 只能是 `agent`、`all`、`api`、`ingest-worker`、`model-gateway`、`retrieval`。一把公钥只对它登记的 issuer 有效：用 retrieval 的私钥冒充 api 签名会被拒（401 `SERVICE_TOKEN_KEY_ISSUER`）。`ed25519` / `mixed` 下被调用的层（agent、retrieval、model-gateway）必须配置。 |
| `INTERNAL_SERVICE_REQUEST_BINDING` | 不设 | token 是否必须绑定到这次请求。不设时 Ed25519 token 必须绑定，HS256 token 带了绑定才校验；`required` / `optional` 对两种都生效。其他值让拆分角色拒绝启动，单体只给警告。 |
| `INTERNAL_SERVICE_REPLAY_CACHE` | `ed25519`、`mixed` 下开，`hmac` 下关 | 防重放：每个 token 只接受一次，直到过期。取值 `on`/`true`/`1`/`yes` 或 `off`/`false`/`0`/`no`；其他值让拆分角色拒绝启动，单体只给警告。 |
| `INTERNAL_SERVICE_REPLAY_CACHE_MAX_ENTRIES` | `100000` | 每个进程的防重放缓存上限。满了以后淘汰最老的条目，这些 token 的重放窗口随之重新打开。 |
| `INTERNAL_SERVICE_ISSUER` | 角色名 | 只能设为 `ingest-worker`，而且只能用在 `ARCHIVE_RAG_ROLE` 为 `all` 的独立入库 worker 上（`npm run worker:ingest`）。这样 worker 按调用策略只能调用模型网关；不设时它以 `all` 签名。 |
| `INTERNAL_SERVICE_TOKEN_TTL_MS` | `60000` | 内部 token 的有效期，限制在 1 秒到 1 小时之间。 |
| `INTERNAL_SERVICE_TOKEN_CLOCK_SKEW_MS` | `5000` | 校验 token 时容忍的时钟偏差，限制在 0 到 60 秒之间。 |

- **调用策略**：谁能调用谁写在 `server/rag/service-identity.js` 的 `SERVICE_CALL_POLICY` 一张表里，在接收方执行，三种模式都生效：agent 只接受 `all`、`api`；retrieval 只接受 `agent`、`all`（健康探测另外接受 `api`）；model-gateway 接受 `agent`、`all`、`api`、`ingest-worker`、`retrieval`。默认 `hmac` 下这也是新行为：以前模型网关接受任何 issuer，检索层的探测接口也接受任何 issuer。代码里现有的调用方都在表内。
- **请求绑定**：service client 每次尝试都重新签一个 token，写入方法（`htm`）、路径加查询串的 SHA-256（`htu`，查询串里可能有问题文本，所以只传摘要）和非空请求体的 SHA-256（`bdh`）。接收方核对方法和路径，请求体由 JSON 解析器的校验钩子核对；带 `bdh` 的 token 只接受 `application/json` 请求。拦截到的 token 换一个接口或换一个请求体都用不了。内部链路上如果有改写路径或请求体的反向代理，三种模式下都会被拒。
- **防重放**：按进程记录已接受的 token id。设了 `RAG_SHARED_STATE=redis` 时用 `SET NX PX` 在同一层的副本之间共享；Redis 出错时退回本进程判断。失败转移和重试每次都用新 token，不受影响。
- **算法固定**：每把 key 只用一种算法，HS256 和 EdDSA 互不验证；签名必须是规范的 64 字节。HMAC 仍用常量时间比较，过期和时钟偏差检查不变。
- **启动校验**：以下配置启动时直接拒绝：会调用别的层却没有私钥；被调用的层对任何一个合法调用方都没有受信公钥；本进程的 kid 在受信列表里绑定到别的 issuer 或别的公钥；`mixed` 下被调用的层没有 `INTERNAL_SERVICE_KEYS`；HMAC 和 Ed25519 的 kid 重复。一把公钥绑定多个 issuer、`ed25519` 下还留着 `INTERNAL_SERVICE_KEYS` 只给警告。报错里只有变量名和 kid，没有密钥。校验只要求"至少信任一个合法调用方"，比如网关只信任 api 的公钥也能启动，agent 和检索层调用它时才会在运行时得到 401。`npm run worker:ingest` 和 `chat-mcp.js` 不做这项校验，配置错误要到第一次调用网关时才暴露。
- **生成密钥**：`node server/service-keys.mjs generate <issuer> [--kid <id>]`、`compose`、`public <issuer>`，只往标准输出打印，不写文件。生成、分发和轮换步骤见 [deployment.md](deployment.md#内部身份与密钥)。
- 这不是 mTLS，层间也没有加密。`hmac` 下每一层都持有同一组密钥，issuer 是调用方自己写的；`ed25519` 下每层只能以自己的身份签名。两种模式下内部端口都只能放在内网。

### 调用、超时和停机

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `INTERNAL_SERVICE_TIMEOUT_MS` | `60000` | 层间调用的默认总预算，包括换副本重试和读取响应体，作为 `x-archive-service-deadline-ms` 发给对方。转发 `/chat/stream` 时只限制等响应头的时间。 |
| `INTERNAL_SERVICE_UNHEALTHY_COOLDOWN_MS` | `5000` | 副本连接失败或返回 502/503/504 后，多长时间内优先选别的副本。只剩这一个副本时照样会用它。 |
| `AGENT_SERVICE_TIMEOUT_MS` | `300000` | 公网入口等 agent 层回答一个转发请求的时间，也是一次 `/chat/stream` 的总时长上限；限制在 1 秒到 1 小时之间。它作为截止时间发给 agent 层，agent 层按它限制自己发出的检索和模型调用，到点时在下一个安全点取消运行（`deadline_exceeded`，见下面的"截止时间、取消和依赖故障"）。入口超时返回 504。注意：转发的管理动作（例如 `quality-refresh`）、步骤重试和恢复动作也受这个上限约束，到点时进行中的模型调用会被中止，以前它们会继续跑完。 |
| `SERVICE_SHUTDOWN_GRACE_MS` | `25000` | 用 `node server.js` 启动的拆分角色收到 SIGTERM/SIGINT 后，给进行中的请求多长时间结束，之后关闭剩下的连接并退出；限制在 0 到 10 分钟之间。`node retrieval-service.mjs` 和 `node model-gateway.mjs` 这两个入口没有这个上限，会一直等请求结束。 |

- 选副本：选进行中请求最少的，相同时轮流。每次调用每个副本最多试一次。连接没建立起来（ECONNREFUSED 等）时任何请求都换下一个副本；请求已经发出之后，只有幂等的请求才换副本。已经发出的 `/chat`（包括 GET）和任务操作不会再发给第二个副本，避免一次提问跑两遍。
- 截止时间：一个请求绑定了截止时间时（见下面的"截止时间、取消和依赖故障"），远程检索和经网关的模型调用的预算取"自己的超时"和"剩余时间"中较小的一个，发给下一层的截止时间头随之缩短。
- trace：配置了 OpenTelemetry 时，调用带 `traceparent`，跨层是同一条 trace。用 `node server.js` 启动的各角色默认用同一个服务名，要在后端区分，给每个角色设不同的 `OTEL_SERVICE_NAME`。

### 检索层

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RETRIEVAL_SERVICE_TIMEOUT_MS` | `0` | 调用方一次远程检索的预算；`0` 表示用 `INTERNAL_SERVICE_TIMEOUT_MS`。 |
| `RETRIEVAL_SERVICE_MAX_DOC_IDS` | `1000` | 检索层一次请求最多接受的文档数。超出返回 400。 |
| `RETRIEVAL_SERVICE_MAX_QUERIES` | `32` | 一次请求最多的检索查询数。 |
| `RETRIEVAL_SERVICE_MAX_QUERY_CHARS` | `32000` | 单条查询的最大字符数。单体对问题长度没有这个限制，超长问题在拆分模式下会返回 400。 |
| `RETRIEVAL_SERVICE_MAX_TOP_K` | `500` | topK 上限。`RAG_RETRIEVAL_TOP_K`、`RAG_QA_VERDICT_RETRY_TOP_K` 不要配得比它大。 |

- 检索层监听 `PORT`，默认 5002。它需要 PostgreSQL，并且拒绝 `VECTOR_STORE_PROVIDER=local` 和 standalone 模式，因为那样它搜的是自己进程里的旧副本。
- 检索相关的 `RAG_*`、`OPENAI_EMBEDDING_*`、`RAG_EMBEDDING_QUERY_ADAPTER` 等由检索层读取，但 agent 层仍读 `RAG_RETRIEVAL_TOP_K` 等少数几项。两层要用同一份配置，目前没有自动检查。

### 模型网关

网关进程读取的变量：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `MODEL_GATEWAY_PORT` | `PORT`，再是 `5003` | 网关监听的端口。 |
| `MODEL_GATEWAY_CHAT_UPSTREAMS` | `OPENAI_BASE_URL`，再是 `OPENAI_API_BASE`，再是 `https://api.openai.com/v1` | chat 上游副本，逗号分隔，写法和 `OPENAI_BASE_URL` 相同。 |
| `MODEL_GATEWAY_EMBEDDING_UPSTREAMS` | 同上 | embedding 上游副本。 |
| `MODEL_GATEWAY_RERANK_UPSTREAMS` | `RAG_CROSS_ENCODER_ENDPOINT` | 重排上游副本，写完整地址（如 `http://reranker:8081/rerank`）。为空时 `/rerank` 返回 503 `MODEL_GATEWAY_BACKEND_NOT_CONFIGURED`。 |
| `MODEL_GATEWAY_QUOTA_REQUESTS_PER_MINUTE` | `0` | 每个 workspace 每分钟的请求数上限；`0` 关闭。 |
| `MODEL_GATEWAY_QUOTA_TOKENS_PER_MINUTE` | `0` | 每个 workspace 每分钟的 token 上限；`0` 关闭。 |
| `MODEL_GATEWAY_QUOTA_DAILY_TOKENS` | `0` | 每个 workspace 每个 UTC 日的 token 上限；`0` 关闭。 |

- 其余沿用原有变量，由网关读取：`OPENAI_API_KEY`、`OPENAI_CHAT_MODEL`、`OPENAI_CHAT_FALLBACK_MODEL`、`RAG_LLM_REQUEST_TIMEOUT_MS`、`RAG_LLM_MAX_CONCURRENCY`、`RAG_LLM_CIRCUIT_*`、`RAG_SHARED_STATE` / `REDIS_URL`、`RAG_CROSS_ENCODER_MODEL`、`RAG_CROSS_ENCODER_TIMEOUT_MS`。并发上限和熔断按"上游副本 + 模型"计算，每个副本各有一份。
- 配额：窗口是固定的（当前分钟、当前 UTC 日）；没有 workspace 时按用户计；系统调用不受限。token 在模型回答后才扣，所以进行中的调用可能让 workspace 超出一次。`RAG_SHARED_STATE=redis` 时所有网关副本共享计数，否则每个网关进程各算各的。超出时返回 429 `MODEL_GATEWAY_QUOTA_EXCEEDED`，带 `Retry-After`。
- chat 走网关自己的模型注册表，请求里的 `model` 字段被忽略，所以调用方和网关的模型变量要一致；`RAG_STRUCTURED_OUTPUT_ENABLED` 两边都要开。embedding 用调用方指定的模型，任务前缀、固定的 embedding 空间和查询适配器都在调用方处理。

调用方（api、agent、retrieval 或 `all`）读取的变量：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `MODEL_GATEWAY_TIMEOUT_MS` | `600000` | 一次经网关的模型调用的总预算，包括网关里的重试、退避和切换备用模型，作为截止时间发给网关；网关在截止时间到了或调用方断开时停止重试、取消上游请求。重排不用它，仍用 `RAG_CROSS_ENCODER_TIMEOUT_MS`。 |

- 经网关时，调用方自己不重试、不切换模型、不做并发上限和熔断，只在网关副本连不上时换一个副本。网关连不上返回 503 `MODEL_GATEWAY_UNAVAILABLE`，预算用完返回 504 `MODEL_GATEWAY_TIMEOUT`，应答不是网关的格式返回 502 `MODEL_GATEWAY_PROTOCOL_ERROR`；重排失败时照旧退回融合排序。
- 调用方不需要 `OPENAI_API_KEY`，`/health` 的 `openai` 项显示 `gateway: true`。Web 回答路径（`chat-mcp.js`）在网关模式下也不再要求本进程有这个 key。
- LLMOps 计量：网关每次尝试记一条带 `model_gateway_metered` 标注和租户的事件，这是权威数据；调用方每次调用只记一条 `model_gateway_mirror` 镜像事件，用量取网关的计量值，运行级的 token 和成本上限因此照常生效。汇总时要跳过镜像事件，`observability:report` 已经这样做，所以网关和调用方的事件可以放在一起统计。

## 截止时间、取消和依赖故障

单体和拆分部署都适用。两个开关默认都关，单体里什么都不绑定，行为和以前一样；拆分部署的 agent 层总是带着公网入口的截止时间（`AGENT_SERVICE_TIMEOUT_MS`）。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `AGENT_REQUEST_TIMEOUT_MS` | `0` | 本进程里一个 Agent 请求（`/chat`、`/chat/stream`、`POST /agent-runs/:runId/actions/:action`）从到达起的截止时间，单位毫秒；`0`、空或无效值表示不限。拆分部署的 agent 层同时收到上游的截止时间时，取较早的那个。可以设很大的值：超过 `setTimeout` 上限（约 24.8 天）时分段计时，不会立即触发。 |
| `AGENT_CANCEL_ON_DISCONNECT` | `off` | 设为 `on`/`true`/`1`/`yes` 时，客户端断开（包括在路由绑定之前就断开）会取消这次运行，运行以 `canceled` 结束。关闭时客户端断开后运行照常跑完。 |

- **取消什么**：绑定后，请求里的出站调用预算取 min(自身超时, 剩余时间)，并带上取消信号：远程检索、模型网关客户端、直连模型的 chat 和 embedding（重试的退避也可中断，中断后不再重试）、交叉编码器重排、Web 搜索。自定义 provider 的 `completeText` 能收到信号，`embedTexts` / `embedQuery` 收不到。
- **在哪里停**：运行只在安全点停下：每个执行阶段开始前、每个步骤或图节点启动前、Skill 执行入口、finalize 之前。会写工作区的 Capability（`approvalPolicy.writesWorkspace`）一旦开始就脱离取消信号跑完，步骤记为完成，副作用保留、不会重放，运行在下一个安全点结束。数据库语句不读取消信号，所以每个步骤的结果都会被记录。后台任务不继承请求的截止时间或取消信号。
- **结束状态**：超时的运行记为 `failed`，`run.error` 带 `code: AGENT_DEADLINE_EXCEEDED`、`reason: deadline_exceeded`、`retryable: true`；客户端离开的运行记为 `canceled`，`AGENT_CLIENT_CANCELLED`，`retryable: false`。启动恢复不会接手这两种运行。运行里已经有 Capability 调用完成时，超时或依赖故障都记为 `retryable: false`，应答也不带 `Retry-After`，因为重试会再写一次。
- **熔断**：调用方自己取消的模型调用（超时或客户端离开）既不算失败也不算成功，不会把模型熔断。
- **应答**：超时返回 504 `{code: "AGENT_DEADLINE_EXCEEDED", reason, retryable: true, agentRunId}`，不带 `Retry-After`；客户端已离开时记 499。`/chat/stream` 以 `error` 事件（同样的字段加 `status`）和 `done` 结束，没有 `result`。

依赖故障（默认就生效，不需要开关）：

- 主文档检索步骤因为依赖不可用而失败时，`/chat` 现在返回 503 `AGENT_DEPENDENCY_UNAVAILABLE`（依赖超时时 504 `AGENT_DEPENDENCY_TIMEOUT`），带 `Retry-After`（依赖给了就用它的，否则 5 秒）和 `{code, error, dependency, causeCode, retryAfterSeconds, retryable: true, agentRunId}`，运行记为 `failed` 且 `retryable: true`。以前这种情况会转去请求 Web 搜索审批，返回 200 的 clarification。
- 算作依赖故障的只有：拆分部署里某一层不可达或超时、模型网关不可用或超时、模型上游不可用、熔断打开、检索层报告自己的依赖故障、直连模型返回 5xx 或 408 或连不上、PostgreSQL 连接类错误（SQLSTATE 08xxx、57P01–57P03、53300、连接断开）。判断只看错误码和状态码，不看错误信息；应答里也不带原始错误信息。4xx、429、协议错误不算，保持原来的应答。
- 同样按故障处理的还有：统一图里主 `document_rag` 节点故障、自定义 Skill 阶段的每个结果都因故障失败、research brief 的每个问题都因故障失败。普通的证据不足仍返回 200 的 clarification。后台任务遇到依赖故障时任务直接失败，不再暂停等 Web 审批。
- 拆分部署时，公网入口把 agent 层的 503/504 原样转发，并按应答体的 `retryAfterSeconds` 补上 `Retry-After`；入口自己因为 agent 层不可达返回的 503/504 带 `Retry-After: 5`。

已知边界：

- V1 路径上，会写工作区的 Capability 越过截止时间跑完后，运行以 `deadline_exceeded` 失败，标记为不可重试。统一图在最后一个节点之后没有安全点，同样情况下运行会完成，两条路径不一致。
- 模型并发上限的排队（`RAG_LLM_MAX_CONCURRENCY`）不响应取消信号，排队中的调用要拿到槽位后才结束。
- 检索层不会因为调用方断开而停止，只在自己的截止时间到时停。
- 统一图里非主节点（补检索、Web、自定义 Skill）遇到依赖故障仍以 409 `AGENT_UNIFIED_GRAPH_PARTIAL` 结束；统一图审批续跑里遇到依赖故障仍进入人工恢复。统一图默认关闭。
- 直连模型连接失败时 `dependency` 是 `dependency`，不是 `model`；状态码和 code 是对的。
- agent 层因为依赖故障返回 503 时，入口仍会把这个 agent 副本当成不健康，跳过 `INTERNAL_SERVICE_UNHEALTHY_COOLDOWN_MS`（只有一个副本时照样会用它）。

## Observability

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RAG_OBSERVABILITY_ENABLED` | `false` | 是否写入 RAG / AgentRAG JSONL trace。 |
| `RAG_OBSERVABILITY_INCLUDE_CONTEXT` | `false` | Trace 是否记录完整 chunk 文本。 |
| `RAG_OBSERVABILITY_EVENTS_PATH` | 空 | 把 trace 写到指定的 JSONL 文件，而不是默认的 `server/data/rag-observability/events.jsonl`；评测用它把一次运行的事件单独保存。 |
| `FEEDBACK_DIRECTORY` | `server/data/feedback` | 答案反馈 JSONL 存储目录。 |

默认 trace 只保存 metadata、score、`excerptHash` 和短 preview。启用后，completion、embedding 和 cross-encoder rerank 还会写入 `llmops_metric` 事件，用于 `observability:report` 汇总 operation / model route 的 count、平均延迟和 error rate；这些事件不包含 prompt 原文或 secret。只有本地调试且能接受完整 chunk 文本落盘时，才建议设置：

```env
RAG_OBSERVABILITY_INCLUDE_CONTEXT=true
```

生成可读汇总报告：

```bash
cd server
npm run observability:report
```

### OpenTelemetry trace

JSONL trace 适合离线汇总；要在界面里看"一次请求里每一步花了多久"，打开 OpenTelemetry：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `OTEL_TRACING_ENABLED` | `false` | 为 `true` 时 `server.js` 启动 OpenTelemetry SDK（`server/otel.js`）并按 OTLP/HTTP 导出。关闭时代码里的 span 调用是空操作，`/chat` 响应不变。 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `http://localhost:4318` | 标准 OTLP 变量，由导出器自己读取。前者是基地址（自动追加 `/v1/traces`），后者是完整地址。 |
| `OTEL_EXPORTER_OTLP_HEADERS` | 无 | 标准 OTLP 变量，例如认证头。 |
| `OTEL_EXPORTER_OTLP_PROTOCOL` / `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | `http/protobuf` | `http/protobuf` 或 `http/json`。Phoenix 的 `/v1/traces` 只接受 protobuf，对 JSON 返回 415；gRPC 未接入，会回落到 `http/protobuf` 并打印警告。 |
| `OTEL_SERVICE_NAME` | `luc1ferxx-archive-rag` | trace 后端里显示的服务名。 |

一次 `/chat` 是一条 trace：根 span `invoke_agent archive_rag`，下面是 `agent.plan intent` / `agent.plan execution` / `agent.plan skill_graph` 三个规划 span、每个 Skill 一个 `execute_tool <skillId>` span，Skill 发出的每次模型调用是它下面的 `chat <model>` 或 `embeddings <model>` span（CLIENT，带 `gen_ai.usage.input_tokens` / `output_tokens`、LLMOps 估算成本和重试事件）。Agent 步骤是 `agent.step` 事件，只有类型、标签和状态。属性遵循 OpenTelemetry GenAI 语义约定，**不记录问题、prompt、模型输出或文档内容**。开启后 `agentObservability.traceId` 给出这次请求的 trace id，根 span 上有 `agent.run.id`，可以从运行记录找到 trace，也可以反过来。

接 Phoenix（本地，镜像需自行拉取）：

```bash
docker run -p 6006:6006 arizephoenix/phoenix
```

```env
OTEL_TRACING_ENABLED=true
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:6006/v1/traces
```

接 Langfuse（云或自托管；接受 protobuf 和 JSON，不支持 gRPC；认证是 `public key:secret key` 的 base64）：

```env
OTEL_TRACING_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(pk-lf-...:sk-lf-...)>
```

不接后端也能看：`cd server && npm run trace:demo` 在内存里跑一次合同审查请求并把 span 树打印出来；加 `-- --real` 用配置好的模型端点（例如本地 Ollama），加 `-- --otlp` 同时导出到上面配置的后端。

### Prometheus 指标

默认关闭。打开后每个进程（单体、四个拆分角色、`node retrieval-service.mjs`、`node model-gateway.mjs`、`npm run worker:ingest`）在单独的端口上提供 `GET /metrics`，应用端口不提供。怎么接 Prometheus 和告警规则见 [deployment.md](deployment.md#指标与告警可选) 和 [operations.md](operations.md)。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `METRICS_ENABLED` | `false` | 只有 `true`（不分大小写）才打开记录和监听；`1`、`on` 不算。关闭时每个埋点只多一次布尔判断，不监听任何端口。 |
| `METRICS_PORT` | `9464` | 指标监听端口；`0` 表示由系统分配，实际端口打印在启动日志里（`[metrics] serving /metrics on http://HOST:PORT`）。只在打开时检查：不是 0–65535 的整数，或端口被占用，都拒绝启动。同一台机器上的多个进程要各用一个端口或 `0`。 |
| `METRICS_HOST` | `127.0.0.1` | 监听地址。Prometheus 在另一个容器或主机上时设 `0.0.0.0`，并同时设 `METRICS_TOKEN`；不设 token 时启动会打印警告。 |
| `METRICS_TOKEN` | 空 | 设置后，抓取必须带 `Authorization: Bearer <token>`（常量时间比较），否则返回 401。 |

- 只接受 `GET` 和 `HEAD /metrics`（查询串忽略），其他方法 405，其他路径 404。格式是 Prometheus 文本格式 0.0.4，没有用客户端库。
- 指标族：HTTP 请求数、耗时、在途数（按方法、Express 路由模板、状态类别，429 和 `aborted` 单独一类）；Agent 运行（按结果和原因）、运行耗时、步骤；模型调用次数、耗时、token、估算成本（按 `metering`：`direct`、`gateway`、`mirror`；跨进程汇总时排除 `mirror`）；模型调用守卫的在途、排队和熔断状态；网关配额拒绝；检索各路由的耗时和候选数、重排降级、语义缓存；入库队列深度（最多 15 秒查一次）、各阶段耗时和失败；PostgreSQL 连接池和按 SQLSTATE 类别的语句错误；读副本的读取、回退和延迟；层间调用的次数、故障转移、副本数；进程 CPU、内存、堆和事件循环 p99。
- 标签规则：序列里没有 `role`、`instance`、`job`，这些由抓取配置加；租户、用户、文档、问题、URL、主机之类的标签名在注册时就被拒绝。每个指标族最多 1000 组标签，超出的观测记到一个所有标签都是 `_overflow` 的序列里，并计入 `archive_rag_metrics_series_overflow_total`。
- 读数类指标（连接池、队列、守卫状态、副本）在每次抓取前读取，有超时；失败时保留上一次的值，并计入 `archive_rag_metrics_collector_errors_total`。
