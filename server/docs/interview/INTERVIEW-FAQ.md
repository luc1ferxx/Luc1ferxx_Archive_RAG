# Interview FAQ — high-frequency follow-ups

*Each answer is code-grounded (`file:line` under `server/`). Effect numbers cite the
§6 **same-SHA** table in `CURRENT-TRUTH.md` — deterministic-provider results stamped
at the committing SHA with a clean worktree; the ranking columns are
git-state-independent, so they reproduce identically. Never invent a number or quote
an expired report.*

---

### Q1. How do you chunk, and why 900/180?
Default is the `structured` strategy at **900 chars with 180 overlap**
(`rag/config.js:89-90`, `:298-302`). Structured means it respects document
structure (headings/sections) rather than blind fixed windows, and chunk metadata
carries `sectionHeading`/`pageNumber` so citations can point at a real location
(`rag/citations.js:7-16`). The 20% overlap keeps a fact that straddles a boundary
retrievable from either side. It's all env-tunable; 900/180 is the default, not a
hard-coded constant.

### Q2. Explain RRF. Isn't the fused score a relevance probability?
No — and that distinction is the point. RRF gives each candidate
`Σ_route weight/(k + rank_route + 1)` with **k=60** (`rag/vector-store.js:324-325`,
`rag/config.js:102-103`). It fuses *ranks*, so it's robust to the two routes
having incomparable score scales (cosine in [0,1] vs. unbounded `ts_rank_cd`). I
scale the raw sum by `(k+1)` into a readable [0,1] **ranking figure** so a chunk
ranked #1 on both routes reads as 1.0 (`rag/vector-store.js:380-394`) — but that
scaled value is explicitly a **rank, not a confidence**. The raw sum is retained
as `rrfScore` for provenance only. Anything that needs "is this good evidence"
uses the admission score instead (see Q4).

### Q3. What does rerank do, and when is it on?
Rerank is **off by default** (`rag/config.js:313-314`). When enabled it pulls a
wider candidate set — `candidateMultiplier = 3` (`:323-327`) — reranks, and blends
the rerank score with the fusion rank at `weight = 0.6` (`:329-330`). Providers:
`heuristic` (default), `custom`, or an external `cross-encoder`
(`:316-321`, `rag/reranker.js`). The cross-encoder provider *requires* an endpoint
and fails closed if it's missing (`rag/reranker.js:414`) — no silent degradation
to "no rerank." On quality: in the §6 **same-SHA** (deterministic) run,
**hybrid+rerank ≥ hybrid RRF on every split** — rerank partially repairs
rank-fusion dilution. The production-representative ordering needs a real-embedding
run (credential-gated), so quote §6 as a wiring / relative check, not a deployment
result.

### Q4. What exactly is the evidence gate / refusal logic?
The gate is `admissionScore = max(vectorScore, keywordScore)`
(`rag/citations.js:27-35`) — the strongest **bounded** raw retrieval signal.
`sparseScore` (`ts_rank_cd`) is deliberately excluded because it's unbounded and
would let a single lexical spike clear the bar. When admission + confidence are
too low, the run raises the `insufficient_evidence` trigger
(`rag/agent-replanner.js:40`, `:202`) and either refuses or launches supplemental
retrieval. The refusal is decided on raw retrieval strength, **never** on the
scaled RRF rank — which is the whole reason those two numbers are kept separate.

### Q5. Multi-query: how do you avoid double-counting and rank drift?
Decomposition produces up to **4** sub-queries (`rag/config.js:362-366`). Each
retrieves independently, then `mergeRetrievedResults` performs **stable
de-duplication** (same chunk found by two sub-queries collapses to one, keeping
the best signals) and a **single global re-rank** into one unified Top-K
(`rag/vector-store.js`; contract in `test/hybrid-retrieval-provenance.test.mjs:233`).
Citation `rank` is assigned from that final order, so what the user sees as
"Source 1" is genuinely the top-ranked merged chunk — verified in
`test/rag-boundary-coverage.test.mjs` and `test/source-labels.test.mjs`.

### Q6. Supplemental retrieval — is it a loop that can run away?
No. It's **one bounded round**. The gap planner detects missing aspects and emits
**≤ 3** deduplicated supplemental queries (`rag/gap-planner.js:660-684`, the
`.slice(0, 3)` at `:663-664`). Each is embedded and retrieved globally, merged
with the originals, and the gap is **re-planned exactly once**
(`rag/document-rag-execution.js:411-463`). There's no recursive re-entry, so the
worst case is bounded and cheap.

### Q7. Memory and recovery — what happens when an agent run breaks mid-way?
Session memory drives follow-up rewriting (`rag/memory.js`), kept separate from
document evidence — long-term memory is treated as *user preferences*, never as a
fact source (see the v3 prompt rules, `rag/memory.js:88-89`). For run recovery,
`rag/agent-run-recovery-actions.js` builds an explicit recovery state
(`buildAgentRunRecoveryState`, `:118`): a failed step can be marked
auto-recoverable, or the run parks in a "waiting for manual recovery" state that an
operator can **resume** or **cancel** (`:299-326`). Step replay is idempotency-
guarded so a resumed step doesn't double-write
(`test/agent-run-step-replay-safety.test.mjs`).

### Q8. How is retrieval evaluated, and what stops leakage?
The suite compares **dense-only, sparse-only, hybrid RRF, hybrid + rerank** on the
same corpus, reporting Recall@K, NDCG, MRR, citation-support rate, refusal
accuracy, latency p50/p95, and token/cost. Tuning and held-out sets are split **by
source document** so the same document — or a near-duplicate — never appears on
both sides. Every report is stamped with commit SHA, clean/dirty state, config
hash, provider, model, and corpus hash (`evaluation/eval-evidence.js:176`,
`buildEvaluationEvidence`). **Numbers:** §6 of `CURRENT-TRUTH.md` holds the current
**same-SHA** table (deterministic provider), stamped clean at the committing SHA and
git-state-independent, so it reproduces identically. The release gate
(`npm run release:gate`) separately enforces 8 same-SHA reports ≤ 24h old
(`evaluation/eval-evidence-policy.js`); its `planner-real` report needs a real model
key, so a green release gate is a credential-gated boundary (see `EVIDENCE-STATUS.md`),
distinct from the deterministic §6 evidence.

### Q9. A query returned the wrong chunk — how do you debug it from the trace?
The retrieval trace records the architecture that actually ran —
`vectorStoreProvider`, `hybridEnabled`, `hybridFusionMethod`, `rrfK`
(`rag/document-rag-execution.js:465-469`) — plus per-candidate
`admissionScore` and `rrfScore`, with the note that admission drives confidence
and `rrfScore` is provenance only (`rag/observability.js:119-120`). So the debug
path is: check whether both routes executed and their `queryCount`; compare a
candidate's `vectorScore`/`keywordScore` (did it fail *admission*?) against its
`score` (did it just lose the *ranking*?); confirm the ANN index is the configured
method via health (Q10). That tells you whether it's an embedding problem, a
lexical-tokenization problem, or a fusion/ranking problem.

### Q10. Latency and cost — where does time and money go, and how do you bound it?
Embedding calls are cached with a TTL (`rag/embedding-cache.js`) and in-flight
de-duplicated so two concurrent identical queries embed once
(`test/embedding-cache.test.mjs:110`). Rerank cost scales with the candidate
multiplier (3×) and only applies when rerank is enabled. The deterministic eval
provider makes latency/cost measurable without paying for a real model. Health can
flag an ANN index that silently fell back to a sequential scan (e.g. embeddings
above the 2000-dim ceiling), which is the usual cause of a latency cliff
(`rag/config.js:244-254`; `test/vector-store-health.test.mjs`). **p50/p95 latency
and est. token/cost:** see the §6 **same-SHA** table — a *relative* in-process signal
under deterministic embeddings (rerank present in every arm), explicitly **not** a
production SLA. Latency is the one **non-deterministic** column (wall-clock varies
run-to-run; the live report carries each run's exact p50/p95); sparse-only embeds 0
query tokens.

### Q11. Why pgvector, and how do you handle the 2000-dim ANN ceiling?
pgvector keeps vectors, chunks, and the FTS index in one transactional store, so
ingest/delete/re-index are atomic and there's no vector-vs-metadata drift. pgvector's
HNSW/IVFFlat ANN indexes cap at 2000 dims; the default `text-embedding-3-small`
(1536) is fine, but `text-embedding-3-large` (3072) exceeds it. Rather than pretend,
re-index and health **fail closed** and explain the sequential-scan consequence
(`rag/config.js:244-254`, `vector-reindex.test.mjs`, `vector-store-health.test.mjs`).

### Q12. What's genuinely *not* done yet? (say this plainly)
The deterministic **effect metrics (§6)** are finalized **same-SHA** in this commit —
that part is done. What remains is **execution-environment-gated, not code-gated**. (1)
The **real-database integration suite** self-skips until a live pgvector is
reachable; the runner is built and docker-free (`scripts/run-pgvector-integration.sh`
spins up a throwaway **Postgres.app 18 + pgvector** cluster — both verified installed
on this machine; the runner prints exact versions at runtime — on an OS-picked port,
dev DB untouched), but the Bash sandbox blocks *all* sockets (TCP + unix-domain
`listen()` and outbound `connect()` all return EPERM) and the terminal is tab-capped,
so it needs one shell outside the sandbox to run **unskipped** (`FULL_SUITE=1` also
clears the 47 sandbox-only HTTP-route tests in the same run). (2) The
**DB-backed quality & release gates** — `npm run quality:current` regenerates the
quality battery under a live pgvector route, and `npm run release:gate` requires a
`planner-real` report produced with a **real model key**; both are terminal- /
credential-gated and neither is claimed green here. (To be precise: `git` itself works
fine — an earlier note blaming the Xcode license was wrong; the only nuance is that
`npm run` resolves the bare `/usr/bin/git` shim, so prefix the CLT git path if a stamp
comes back "unknown".)

On the **sparse ranker**, be exact rather than glib: it depends on the backend. The
**default provider is pgvector**, whose sparse route is PostgreSQL
**`ts_rank_cd` / tsvector FTS — which is *not* BM25**. The `local` and `qdrant`
backends use a real **BM25** scorer, and the deterministic eval runs exercise the
**`local`** backend (so the comparison table's sparse arm is genuinely BM25). So
"our sparse side is FTS, not BM25" is true *for the default deployment*, but don't
state it as if the whole system never uses BM25.

Standing scope limits: **text-layer PDF only (no OCR / layout parser)** — scanned or
complex-layout PDFs are detected and reported, not silently mis-parsed — and
**single-agent, not multi-agent**. I'd rather state those than round them off.
