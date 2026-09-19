# 180-Second Project Narrative (speak this)

*Target: ~180 seconds. Every claim maps to `CURRENT-TRUTH.md`. The one
metric-dependent sentence is marked; the numbers behind it are the deterministic
**same-SHA** §6 table — speak them only as a "wiring / relative-behaviour check, not
production quality," since the embedding is non-semantic.*

---

**(0:00–0:25) What it is.**
Luc1ferxx_Archive_RAG is a document-grounded RAG / Agent-RAG service:
upload PDFs, they're chunked and embedded into pgvector, and you ask questions
that are answered *only* from your documents, with citations. It supports
single-document QA, multi-document comparison, evidence-gated refusal, and one
round of automatic supplemental retrieval when the first pass leaves a gap. The
default stack is PostgreSQL + pgvector, `text-embedding-3-small` at 1536
dimensions, structured 900/180 chunking, and hybrid retrieval.

**(0:25–1:05) The core design decision — signal separation.**
The thing I'm most careful about is *not lying with scores*. Retrieval produces
four different numbers and I keep them strictly separate. Dense cosine similarity
and keyword coverage are bounded [0,1] raw signals. PostgreSQL full-text
`ts_rank_cd` is unbounded, so it's ranking-only. RRF fusion combines the two
routes' *ranks* into a single ordering — and its output is a **rank, never a
probability**. So when the system decides "is this real evidence?", it gates on an
admission score — the max of the bounded raw signals — not on the fused rank that
was scaled to look like a [0,1] number. Citations show the admission score; the
fusion value is kept only as provenance. That one discipline is what stops a
confident-looking wrong answer.

**(1:05–1:35) Multi-query and comparison.**
A follow-up like "and the second one?" is rewritten into a standalone retrieval
query — the default v3 prompt handles Chinese and English follow-ups. Complex
questions decompose into up to four sub-queries; every sub-query retrieves
independently, then results are merged with stable de-duplication and a single
global re-rank into one unified Top-K, so citation numbering matches the real
final order. Normal QA retrieves globally; document comparison retrieves
per-document so "partial comparison" and "missing document" stay meaningful
instead of collapsing into one pool.

**(1:35–2:10) Lifecycle and operability.**
pgvector is treated as a real database, not a cache. Re-index re-embeds by default
and only copies stored vectors when the operator attests the source model —
otherwise a same-width vector from a different model would be silently
mislabelled. Dry-run is strictly read-only: no migration, no DDL, no writes.
Embeddings above pgvector's 2000-dim ANN ceiling fail closed with an explicit
explanation rather than pretending an index exists. Health surfaces partial
migrations, wrong model/dimension, and whether the ANN index is *actually* the
configured method.

**(2:10–2:45) Evidence and honesty.**
Correctness and lifecycle are covered by unit and regression tests today —
retrieval correctness is 41 regression tests, all green. The real-database
end-to-end path targets actual PostgreSQL + pgvector — not mocks — via a
one-command throwaway cluster (no Docker); running it *unskipped* is the one step
that still needs a shell outside the sandbox. The effect evaluation compares
dense-only, sparse-only, hybrid RRF, and hybrid + rerank on the same corpus, split
tuning vs. held-out by source document — and that comparison is finalized same-SHA
in §6.
**[METRIC LINE — the deterministic §6 table (same-SHA, this commit) reports the full
suite (Recall@K, NDCG, MRR, citation-support, refusal-accuracy, p50/p95, tokens/cost)
for all four arms; speak it only as a wiring / relative-behaviour check — e.g.
"hybrid+rerank beats hybrid-RRF on every split, and the arms are genuinely
distinct" — never as production semantic quality, which needs the credential-gated
real-embedding run.]**
Those §6 figures are same-SHA but on a *non-semantic* embedding, so I quote no
*production* numbers — and I never call a fusion rank or an engineering threshold a
calibrated probability.

**(2:45–3:00) Boundaries.**
It's text-layer PDF only — no OCR yet, and scanned documents are detected and
reported, not faked. On the default pgvector backend the sparse route is
PostgreSQL FTS, which I don't call BM25 (the `local`/`qdrant` backends do use real
BM25). It's a single-agent RAG framework focused on being correct, reproducible,
and measurable — not an enterprise knowledge platform.
