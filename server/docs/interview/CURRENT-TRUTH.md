# Luc1ferxx_Archive_RAG — Current Truth

> **Status banner (read first).**
> This document records *what the system actually is* — default configuration and
> implemented mechanism — with every claim pinned to `file:line` under `server/`.
> **Mechanism and defaults below are VERIFIED against the code and unit/regression
> tests** (req-1 correctness: **41/41** this session). The **effect metrics** in §6
> (Recall@K, NDCG, MRR, citation-support, refusal accuracy, latency, token/cost) are
> **same-SHA evidence**: produced by the deterministic `npm run eval:retrieval-comparison`
> runner and stamped at the commit that also contains this document, with a **clean
> worktree**. The ranking columns are **git-state-independent** (deterministic
> provider), so a re-run reproduces them identically; the source report
> `evaluation/results/latest-retrieval-comparison.md` carries the live stamp. Never
> fill §6 from a historical/expired report.
>
> - **Commit / worktree stamp:** read it from the report stamp in
>   `evaluation/results/latest-retrieval-comparison.md` (commit SHA + `dirty: false`)
>   or `git rev-parse HEAD`. This document deliberately does **not** hard-code its own
>   commit hash — a file cannot contain its own commit's SHA — so the report is the
>   single source of the stamp. Regenerate it at HEAD with `npm run eval:retrieval-comparison`.
> - **Provider for the eval:** deterministic evaluation provider (no `OPENAI_API_KEY`
>   in `.env`), clearly labeled — **no calibrated-probability claims anywhere**;
>   RRF / in-set-normalized scores are ranking figures, not probabilities.
> - **Still gated (NOT claimed green here):** the DB-backed `quality:current` /
>   `release:gate` batteries and the real-DB integration suite need a live pgvector
>   (and, for `planner-real`, a real model key). Their status lives in
>   `EVIDENCE-STATUS.md`. §6 is the deterministic **effect** comparison, which runs on
>   the `local` backend and needs neither a database nor a key.

---

## 1. Default configuration (the "what runs by default" table)

All defaults are read live from `server/rag/config.js` unless noted. Environment
variables override; the value shown is the fallback when the var is unset.

| Concern | Default | Source |
|---|---|---|
| Vector store provider | `pgvector` (strict allowlist `local`/`pgvector`/`qdrant`, **fails closed** on an unknown value) | `rag/config.js:114`, `:126-173` |
| Embedding model | `text-embedding-3-small` → **1536 dim** (large=3072, ada-002=1536) | `rag/config.js:48-49`, `:178-184` |
| Embedding dim (eval) | **64 dim** deterministic provider override | `rag/config.js:188-199` |
| Chat model | `gpt-5` | `rag/config.js:51` |
| Chunk strategy | `structured` | `rag/config.js:89-90` |
| Chunk size / overlap | **900 / 180** chars | `rag/config.js:298-302` |
| Retrieval Top-K (final) | **6** | `rag/config.js:304-305` |
| Sparse Top-K (candidate) | **8** | `rag/config.js:307-308` |
| Compare Top-K per doc | **3** | `rag/config.js:310-311` |
| Max comparison sources | **8** | `rag/config.js:341-342` |
| Hybrid retrieval | **enabled** (dense pgvector cosine + PostgreSQL FTS) | `rag/config.js:96-97` |
| Fusion method | **`rrf`** (`weighted` available) | `rag/config.js:99-100` |
| RRF constant *k* | **60** | `rag/config.js:102-103` |
| Weighted dense / sparse weights | **0.65 / 0.35** (also weight the RRF per-route contribution) | `rag/config.js:350-354` |
| Rerank | **disabled by default** | `rag/config.js:313-314` |
| Rerank provider | `heuristic` (`custom`, `cross-encoder` available) | `rag/config.js:316-321` |
| Rerank candidate multiplier / weight | **3 / 0.6** | `rag/config.js:323-330` |
| Prompt version (query rewrite) | **`v3`** (`v1`/`v2` available) | `rag/config.js:53-54`, `rag/memory.js:156-168` |
| Query decomposition (multi-query) | **enabled**, ≤ **4** requirements | `rag/config.js:362-366` |
| Near-duplicate guard | **enabled** | `rag/config.js:368-369` |
| Supplemental retrieval (补检索) | **1 round, ≤ 3** deduplicated queries (one per missing aspect) | `rag/gap-planner.js:660-684`, `rag/document-rag-execution.js:411-463` |
| Typed DAG (skill-graph) rollout | **`off`** (`shadow`/`guarded` available; advances only on evidence) | `rag/config.js:77-87` |
| Agent planner rollout | `llm` (execution & intent planners `llm`) | `rag/config.js:56-75` |
| pgvector ANN index | `hnsw` (m=16, ef_construction=64); `ivfflat` (lists=100) available | `rag/config.js:244-254` |
| pgvector FTS config | `simple` (matches the local sparse tokenizer) | `rag/config.js:238-242` |
| Min relevance / vector / keyword weights | 0.32 / 0.82 / 0.18 | `rag/config.js:344-357` |
| Min query-term coverage | 0.51 | `rag/config.js:359-360` |

---

## 2. Retrieval signal separation — the correctness spine

**The single most important design fact:** four distinct signals are kept
separate; the fusion rank is **never** used as a confidence or probability.

| Signal | Meaning | Range | Used for | Source |
|---|---|---|---|---|
| `vectorScore` | dense cosine similarity | [0, 1] | admission + weighted fusion | `rag/vector-store.js:356` |
| `sparseScore` | PostgreSQL `ts_rank_cd` | **unbounded** | ranking only | `rag/vector-store.js:368` |
| `keywordScore` | query-term coverage | [0, 1] | admission + provenance | `rag/vector-store.js:369-372` |
| `rrfScore` | **raw** RRF sum `Σ weight/(k+rank+1)` | small (~≤0.016 at k=60) | **provenance only** | `rag/vector-store.js:324-325`, `:359-377` |
| `score` | scaled RRF **rank** = `rrfScore × (k+1)` | [0, 1] | ordering / rerank blend | `rag/vector-store.js:380-394` |
| `admissionScore` | `max(vectorScore, keywordScore)` | [0, 1] | **evidence gate + citation score** | `rag/citations.js:27-35` |

Two code comments state the contract verbatim:

- `rag/vector-store.js:384-387`: *"This scaled `score` is a fusion RANK, not a
  confidence: evidence admission is gated on admissionScore (raw dense/keyword
  signal), never on this value. The raw sum is kept as rrfScore for provenance."*
- `rag/citations.js:19-26`: *"RRF (or weighted) fusion only ranks candidates; its
  output must never be read as a confidence or relevance probability. Admission is
  the strongest bounded raw retrieval signal… judged on retrieval strength, not on
  a rank-sum that was scaled to clear a threshold. `sparseScore` (ts_rank_cd) is
  unbounded and ranking-only, so it is deliberately excluded here."*

Citations carry the **admission** score, not the fusion rank
(`rag/answer-writer.js:278-279`, `:744`, `:812`), and `rank` is the final fused
order.

**Verified by:** `test/hybrid-retrieval-provenance.test.mjs` (fusion + dedup +
provenance contract), `test/rag-boundary-coverage.test.mjs` (citation dedup,
stable keys, rank), `test/source-labels.test.mjs` (citation rank rebasing).

---

## 3. Cross-query aggregation (req 1)

Multi-query decomposition → each sub-query retrieves independently → results are
merged with **stable de-duplication and a single global re-rank** into one unified
final Top-K, so **citation `rank` is consistent with the final order**.

- Merge/dedup: `mergeRetrievedResults` — `rag/vector-store.js` (contract tested in
  `test/hybrid-retrieval-provenance.test.mjs:233`).
- Global re-rank + unified Top-K: applied after merge, before citation numbering.
- Multi-query provenance recorded (`routes.dense.queryCount`) and asserted in the
  integration suite (`test/vector-store-pgvector.integration.test.mjs`, multi-query
  provenance + citation-ordering cases).

---

## 4. End-to-end route map

- **Normal QA →** *global* retrieval across the active document set
  (`retrieveGlobalContext`, `rag/document-rag-execution.js:420`).
- **Document comparison →** *per-document* retrieval, Top-K **3** per doc
  (`rag/config.js:310-311`); **partial comparison** and **`missingDocuments`**
  semantics preserved.
- **Refusal / insufficient evidence →** gated on `admissionScore` + confidence;
  triggers the `insufficient_evidence` replan path
  (`rag/agent-replanner.js:40`, `:202`); refusal is not driven by the RRF rank.
- **Supplemental retrieval (补检索) →** one round of ≤ 3 deduplicated gap-queries
  (`rag/gap-planner.js:663-664`), merged and re-planned once
  (`rag/document-rag-execution.js:435-462`) — **not** an unbounded loop.

The default query-rewrite prompt (`v3`, `rag/memory.js:83-142`) is **clean of the
prior mojibake** and carries a Chinese follow-up example (`那第二个呢？` →
`第二份文档的远程办公政策是什么？`, `rag/memory.js:124-129`). The dedicated
regression test `test/memory-rewrite-v3.test.mjs` (3 cases) pins both halves: the
rendered v3 prompt **contains the exact expected Chinese and none of the old GBK
mojibake tokens** (`瀵规瘮`, `绗簩浠芥枃妗`, …), and a Chinese pronoun follow-up
actually **drives the rewrite path** (while a self-contained Chinese question is left
untouched). Additional CJK contrast handling is exercised in
`test/claim-support.test.mjs`.

---

## 5. Verified vs. Unverified boundary (be honest in the room)

**VERIFIED now (unit/regression, no database required):**

- **Req 1 — retrieval correctness:** signal separation, cross-query merge /
  global re-rank, citation-rank consistency, Chinese follow-up handling.
  **41/41 regression tests pass** (this session): `retrieval-route-selection.test.mjs`
  (route isolation + fail-closed), `hybrid-retrieval-provenance.test.mjs`,
  `synthetic-retrieval-evidence.test.mjs` (architecture-consistency guard),
  `rerank-report-ranking-validation.test.mjs` + `rerank-eval*.test.mjs`
  (rerank-score vs. fusion-rank separation, forged-report rejection),
  `rag-boundary-coverage.test.mjs`, `source-labels.test.mjs`,
  `memory-rewrite-v3.test.mjs` (Chinese rewrite + mojibake guard),
  `claim-support.test.mjs`.
- **Req 2 — pgvector lifecycle:** dry-run is strictly read-only (no migration /
  DDL / DML), model-provenance re-embed vs. attested copy, ANN > 2000 fails
  closed; health detects invalid provider, pgvector-without-DB, ANN
  actual-vs-configured method, and partial migration.
  Tests: `vector-reindex.test.mjs` (9), `vector-store-health.test.mjs`.
- **Req 4 (effect comparison) — same-SHA, no DB:** `npm run eval:retrieval-comparison`
  compares dense-only / sparse-only / hybrid-RRF / hybrid+rerank on one corpus,
  tuning vs held-out **split by source document**, reporting Recall@K / NDCG / MRR /
  citation-support / refusal-accuracy / latency / token-cost (§6). Deterministic
  **labeled** provider; ranking columns git-state-independent; stamped clean at this
  commit. A **wiring / relative** check under a non-semantic embedding, not a
  production-quality claim.

**NOT YET PRODUCED in this run (execution-environment-gated — see `EVIDENCE-STATUS.md`):**

- **Req 3 — real-DB E2E:** `test/vector-store-pgvector.integration.test.mjs`
  self-skips whenever `PGVECTOR_TEST_DATABASE_URL` is unset. The runner is built and
  docker-free: `scripts/run-pgvector-integration.sh` provisions a **throwaway**
  Postgres.app 18 + pgvector cluster (both verified installed; exact versions printed
  at runtime) on an **OS-picked free 127.0.0.1 port**
  (never 5432; dev DB `agentai` untouched) and runs the suite **unskipped** (with
  `FULL_SUITE=1` it also runs the full backend suite so the 47 sandbox-only route
  tests pass in the same shell). It can't run through the Bash tool because the
  sandbox blocks *all* sockets (outbound `connect`, unix-domain `listen()`, and TCP
  `listen()` — all re-tested EPERM this run); it needs one shell outside the sandbox.
- **DB-backed quality & release gates:** the deterministic **effect comparison**
  (§6) is done same-SHA, but two batteries remain gated. `npm run quality:current`
  regenerates `latest-quality`/`latest-feedback` under `VECTOR_STORE_PROVIDER=pgvector`,
  so its manifest's `vectorStoreProvider === "pgvector"` check (derived from real
  per-case route evidence — a run that fell back cannot pass by declaration) needs a
  **live pgvector**. `npm run release:gate` requires `latest-planner-real.json`, which
  needs a **real model key**. Both are honest execution-/credential-gated boundaries,
  run in the same out-of-sandbox terminal as req 3 (`EVIDENCE-STATUS.md` Touchpoint A);
  neither is claimed green here. `git` itself works (CLT `git` 2.54.0; the resolver at
  `evaluation/eval-evidence.js:184` shells `git` correctly — only the bare
  `/usr/bin/git` shim trips the Xcode license, a PATH detail, **no `xcodebuild
  -license` needed**).

**Standing boundaries (do not overstate):**

- PDF ingestion is **text-layer only** — no OCR / layout parser. Scanned or
  complex-layout PDFs are detected and reported, not silently mis-parsed.
- The sparse ranker is **backend-dependent, and labeled as such in code**
  (`rag/vector-store.js:84,112,131`): the **default `pgvector`** backend ranks with
  PostgreSQL **`ts_rank_cd` cover-density FTS — which is NOT BM25**
  (`rag/vector-store-pgvector.js:788-794`, `sparseBackend: "postgres_fts_ts_rank_cd"`),
  while the **`local`** (`local_json_bm25`) and **`qdrant`** (`qdrant_sparse_bm25`)
  backends use a real **BM25** scorer (`rag/sparse-store.js:7-8,159-179`, k1=1.2/b=0.75,
  IDF + saturation + length norm). The deterministic eval runs use the `local`
  backend, so the §6 sparse arm **is** genuine BM25 — but the shipped default route
  is FTS. Never describe `ts_rank_cd` as BM25.
- The pending eval uses the **deterministic provider** (no OpenAI key present),
  clearly labeled; no real-model or calibrated-probability claims.

---

## 6. Effect metrics — same-SHA evidence (deterministic provider)

> **These are same-SHA evidence, not a preview.** Produced by
> `npm run eval:retrieval-comparison` (deterministic **labeled** provider) and stamped
> at the commit that contains this document with a **clean worktree** — read the live
> commit SHA + `dirty: false` from `evaluation/results/latest-retrieval-comparison.md`.
> The embedding is a **non-semantic hashed term-frequency vector**, so these figures
> validate that the four arms are wired and scored correctly *relative to each
> other* — they are **NOT** production semantic quality and must not be quoted as
> "hybrid beats sparse in deployment." The ranking columns
> (Recall@K/NDCG@K/MRR/citation-support/tokens/cost) are **git-state-independent** and
> reproduce **identically** on any clean re-run; only wall-clock latency varies.
> Corpus hash `dde2bc4f…3bf38c04`. Read that report's "Interpreting these numbers"
> section first.

Tuning and held-out are split **by source document** (no document — or near-duplicate
pair — appears on both sides; every multi-doc `compare` case stays wholly on one
side). The four arms are **fixed configurations**, so the split isolates
generalization rather than fitting to one set. Note the **arm ordering differs
between the two disjoint sets** under this non-semantic embedding — sparse leads
held-out, hybrid+rerank leads tuning — which is exactly why held-out is the primary
figure and why a production ordering needs a real-embedding run.

**Held-out split — primary generalization figure (4 docs, 24 cases, Top-K=5)**
docs: `dense_passage_retrieval`, `colbert_late_interaction`, `react_reasoning_acting`, `toolformer_self_supervised_tools`

| Configuration | Recall@K | NDCG@K | MRR | Citation support | Refusal acc.¹ | Latency p50/p95 ms² | Est. embed tokens / USD³ |
|---|---|---|---|---|---|---|---|
| dense-only | 0.6215 | 0.5192 | 0.5937 | 0.8333 | 1.0000 | ~2.0 / 3.9 | 74576 / $0.001492 |
| sparse-only (BM25) | 0.7083 | 0.6298 | 0.7361 | 0.9583 | 1.0000 | ~0.0 / 1.0 | 0 / $0 |
| hybrid RRF | 0.4306 | 0.3371 | 0.3764 | 0.6250 | 1.0000 | ~2.0 / 3.0 | 74576 / $0.001492 |
| hybrid + rerank | 0.4792 | 0.3802 | 0.4424 | 0.7083 | 1.0000 | ~2.0 / 3.0 | 74576 / $0.001492 |

**Tuning split — held out from the primary figure (4 docs, 24 cases, Top-K=5)**
docs: `rag_knowledge_intensive_nlp`, `self_rag_self_reflection`, `hnsw_approximate_nearest_neighbor`, `attention_is_all_you_need`

| Configuration | Recall@K | NDCG@K | MRR | Citation support | Refusal acc.¹ | Latency p50/p95 ms² | Est. embed tokens / USD³ |
|---|---|---|---|---|---|---|---|
| dense-only | 0.6285 | 0.4569 | 0.4180 | 0.7500 | 1.0000 | ~2.0 / 5.5 | 70439 / $0.001409 |
| sparse-only (BM25) | 0.6493 | 0.5302 | 0.5201 | 0.7500 | 1.0000 | ~1.0 / 1.0 | 0 / $0 |
| hybrid RRF | 0.6563 | 0.5297 | 0.5174 | 0.7500 | 1.0000 | ~2.0 / 3.0 | 70439 / $0.001409 |
| hybrid + rerank | 0.6910 | 0.5597 | 0.5500 | 0.8333 | 1.0000 | ~2.0 / 3.0 | 70439 / $0.001409 |

**Full corpus (8 docs, 48 cases, Top-K=5):**

| Configuration | Recall@K | NDCG@K | MRR | Citation support | Refusal acc.¹ | Latency p50/p95 ms² | Est. embed tokens / USD³ |
|---|---|---|---|---|---|---|---|
| dense-only | 0.6250 | 0.4880 | 0.5059 | 0.7917 | 1.0000 | ~2.0 / 3.0 | 145015 / $0.0029 |
| sparse-only (BM25) | 0.6580 | 0.5686 | 0.6222 | 0.8542 | 1.0000 | ~0.0 / 1.0 | 0 / $0 |
| hybrid RRF | 0.5434 | 0.4334 | 0.4486 | 0.6875 | 1.0000 | ~2.0 / 3.6 | 145015 / $0.0029 |
| hybrid + rerank | 0.5851 | 0.4714 | 0.4996 | 0.7708 | 1.0000 | ~2.0 / 3.6 | 145015 / $0.0029 |

¹ Refusal accuracy is measured on a **separate** abstain-bearing corpus
(`synthetic-corpus-near-duplicate.json`, 2 abstain cases) per arm, not on the arXiv
ranking corpus (which has 0 abstain cases) — hence the same 1.0000 across every split.
² In-process wall time under deterministic embeddings with the heuristic rerank
stage present in every arm — a **relative** cost signal, **not** a production SLA, and
the one **non-deterministic** column: wall-clock varies run-to-run, so values are
shown with `~` and the live report carries each run's exact p50/p95.
³ List-price **estimate** (~4 chars/token, $0.02/1M for `text-embedding-3-small`)
for the equivalent real-model deployment; the deterministic run bills $0. Sparse-only
embeds no query vectors, hence 0 tokens.

**Reading these (all expected under a non-semantic embedding, not defects):**
sparse (BM25) out-ranks the crude dense TF-cosine arm on held-out/full; hybrid RRF can
fall *below* the stronger single arm (equal-per-rank fusion dilutes a strong BM25 list
with the noisy hashed-TF list); rerank partially repairs the fusion damage
(hybrid+rerank ≥ hybrid RRF on **every** split). On the **tuning** split the dense arm
is comparatively stronger, so hybrid+rerank actually **leads** (0.6910 Recall@5) —
underscoring that arm ordering is split-sensitive here. Showing the dense/hybrid
ordering a production deployment would exhibit requires a **real-embedding** run, which
is credential-gated and not part of this deterministic evidence.

Required narrative cases — all five are in `docs/interview/NARRATIVE-CASES.md`, each
pulled from a real run and pointing to its **report file** (not a hard-coded run ID):
≥1 successful answer (`qa_remote_alpha`), ≥1 multi-document comparison
(`compare_remote_numeric_conflict`), ≥1 supplemental retrieval
(`document_follow_up_retrieval`), ≥1 correct refusal (`qa_satellite_stipend_abstain`),
≥1 failure case (hybrid-RRF dilution under the deterministic embedding).

Release-evidence gate (`npm run release:gate`, profile `release`, max age 24h)
expects 8 reports: `compare-hard-synthetic`, `rerank-hard-cs`,
`arxiv-real-paper-rerank`, `trajectory`, `planner-real`,
`recovery-observability`, `runtime-smoke`, `rollout-readiness`
(`evaluation/eval-evidence-policy.js`). `planner-real` requires a real model key, so a
green `release:gate` is a **credential-gated boundary** tracked in `EVIDENCE-STATUS.md`
— it is not claimed here.
