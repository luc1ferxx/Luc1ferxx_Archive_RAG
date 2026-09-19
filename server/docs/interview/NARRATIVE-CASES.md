# Narrative Cases — the five required examples (speak one of each)

Req 4 asks for **at least one** of each: a successful answer, a multi-document
comparison, a supplemental-retrieval round, a correct refusal, and a failure /
limitation case. Each case below names its **case ID + source corpus/suite + the
deterministic command that reproduces it**, so the behaviour is inspectable, not
asserted. References are to *files and commands* — not timestamped run IDs, which
expire — so they stay valid across runs.

> **Deterministic, reproducible behaviour.** Every case is produced by the
> *deterministic* provider, so it is git-state-independent and reproduces
> **identically** on any clean checkout — re-run the command shown to inspect it.
> The **quantitative** claims (Case 4's abstain-accuracy, Case 5's Recall@5) come
> from the §6 effect table, finalized **same-SHA** in
> `server/evaluation/results/latest-retrieval-comparison.md`. Because the embedding
> is **non-semantic**, treat all numbers as a wiring / relative-behaviour signal,
> never as production semantic quality. Report links resolve to
> `server/evaluation/results/`.

How to reproduce each case (deterministic provider; none overwrites the canonical
`latest.json` / quality gate):
- Cases 1, 2, 4 → `node evaluation/run-synthetic-eval.mjs
  evaluation/synthetic-corpus-near-duplicate.json --latest-name latest-narrative
  --openai-provider deterministic` (writes `latest-narrative.{json,md}`, not
  `latest.json`).
- Case 3 → `npm run eval:trajectory`.
- Case 5 → `npm run eval:retrieval-comparison` (this is the §6 report; same-SHA at
  the committing checkout).

---

## Case 1 — Successful single-document QA (grounded + cited)

- **Reproduce:** `node evaluation/run-synthetic-eval.mjs
  evaluation/synthetic-corpus-near-duplicate.json --latest-name latest-narrative
  --openai-provider deterministic` (deterministic provider, `local` store, hybrid
  RRF, top-k 6) → see `latest-narrative.md`.
- **Case IDs:** `qa_remote_alpha`, `qa_badge_gamma` (type `qa`).
- **Result:** pass; abstain **no**; doc-hit, page-hit, answer-hit, claim-support all
  **yes**; ~1–3 ms/case.

**What it shows.** A single-document question retrieves the right chunk, answers
*only* from it, and the citation points at the correct document **and page**, with
the answer's claim actually supported by the cited span (claim-support = yes). This
is the happy path: retrieval → admission → grounded answer → verifiable citation.

---

## Case 2 — Multi-document comparison that surfaces a conflict

- **Reproduce:** the synthetic command above (case
  `compare_remote_numeric_conflict`, type `compare`) — pass; doc-hit / page-hit /
  answer-hit / claim-support all yes. Corroborated by `npm run eval:trajectory` case
  `multi_doc_conflict` (in `latest-trajectory.md`): checks
  *"Answer surfaces a conflict"* and *"Conflict cites both selected documents."*

**What it shows.** Comparison retrieves **per-document** (not one merged pool), so
when two handbooks give different remote-work numbers the answer reports the
**conflict** and cites evidence from **each** document rather than silently picking
one. This is why `partial comparison` and `missing document` stay meaningful — the
per-document route keeps the documents distinguishable.

---

## Case 3 — Supplemental retrieval (one bounded gap-repair round)

- **Reproduce:** `npm run eval:trajectory`, case
  `document_follow_up_retrieval` (mode `document`, in `latest-trajectory.md`) — pass.
- **Trace:** `plan → query_planner → document_rag → self_check → gap_analysis →
  follow_up_retrieval → self_check → synthesis → answer_finalizer`.
- **Checks that passed:** *self-check failed before follow-up and passed after*;
  *gap analysis recorded the unsupported claim*; *focused follow-up retrieval ran*;
  *working memory resolved the evidence gap*; *stayed within retry budget*.

**What it shows.** When the first pass leaves an unsupported claim, self-check
fails, the gap planner emits a **focused** follow-up query, one more retrieval
round fills the gap, and self-check then passes — a single, **bounded** repair, not
a loop.

**The bound (say this alongside):** trajectory case
`budget_exhaustion_clarification` proves the other side — when the follow-up budget
is exhausted the trace records `budget_limit → clarification_gate` and **no further
retrieval runs**; the agent asks for clarification instead of looping. Supplemental
retrieval is capped (≤ 3 deduped queries, re-planned once; `rag/gap-planner.js`,
`rag/document-rag-execution.js:411-463`).

---

## Case 4 — Correct refusal (evidence-gated abstain)

- **Reproduce:** the synthetic command above.
- **Case IDs:** `qa_satellite_stipend_abstain` (type `qa`) and
  `compare_remote_single_doc_abstain` (type `compare`) — both pass with
  **abstain = yes**. Aggregate abstain-accuracy = **1.0** across all four arms —
  same-SHA in `latest-retrieval-comparison.md` (refusal section, separate
  abstain-bearing corpus).

**What it shows.** Asked something the corpus does not support, the system
**declines** instead of fabricating. Refusal is decided on the **admission score**
(`max(vectorScore, keywordScore)`, `rag/citations.js:27-35`) — the strongest
*bounded* raw signal — never on the scaled RRF rank. The compare variant abstains
when only one document carries evidence, preserving `insufficient-evidence`
semantics inside comparison rather than answering half a question as if it were
whole.

---

## Case 5 — Failure / limitation (honest, measured, explained)

- **Source:** the §6 effect table, **same-SHA** in `latest-retrieval-comparison.md`
  (deterministic provider; read its commit stamp + `dirty: false`).
- **Observation (held-out split):** **hybrid RRF fell *below* the stronger single
  arm** — Recall@5 hybrid RRF ≈ **0.43** vs sparse-only ≈ **0.71**; hybrid+rerank
  ≈ 0.48 (partial repair).

**What it shows — and why it is not hidden.** Under the non-semantic
deterministic (hashed term-frequency) embedding, the dense arm is weak, and RRF's
**equal-per-rank fusion** lets collision noise displace good BM25 hits from the
final Top-K. That is textbook **rank-fusion dilution when one input is weak** — not
a fusion bug (the four arms are verified genuinely distinct by
`retrieval-route-selection.test.mjs`), and the reranker partially repairs it, which
is why rerank stays in the default path.

**The boundary I state out loud.** This ordering is a **deterministic-embedding
artifact**, *not* evidence that sparse beats hybrid in production. Claiming
"hybrid > sparse in deployment" requires a **real-embedding run** (credential-gated;
not generated here). I never quote a deterministic arm ordering as a production
result, and I never call an RRF rank or an in-set-normalized score a calibrated
probability.

---

*All five cases trace to files under `server/evaluation/results/` and to the
deterministic commands above. The narrative metric line and `CURRENT-TRUTH.md §6`
cite the same §6 report; the quantitative claims are same-SHA in
`latest-retrieval-comparison.md`, and nothing here reuses an expired or hand-edited
report.*
