# DocCompare — Handoff

Last updated: 2026-08-24. Branch `feat/doccompare-standalone` (12 commits on top of `main`).
Status update 2026-09-25 on `main`: answer quality has now been measured with a real model;
see the update at the top of "The one thing blocking everything".

---

## What this is

DocCompare is an independent product being built out of this repo: a document-comparison
agent that runs with **no infrastructure** — install it, supply one API key, and it
answers and compares questions about PDFs with page-accurate citations.

Two product decisions are locked in and should not be relitigated without the owner:

- **CLI first, GUI later.** The existing React web workbench and its PostgreSQL
  deployment are *not* being replaced. The standalone CLI/MCP path is additive.
- **An API key is the only required configuration.** No PostgreSQL, no vector server.
  Any OpenAI-compatible endpoint works, so a local runtime is a valid substitute for a
  paid key.

Intended distribution: npm global install + runtime-free single-file binaries + a macOS
`.app`.

---

## Status: Phase 1 is done. Phase 2 and 3 have not started, on purpose.

The full three-phase plan (zero-infra RAG → opencode fork rebranding → packaging) is
recorded separately. Phase 1 is complete and verified. **Phase 2 and 3 are deliberately
blocked** — see "The one thing blocking everything" below.

### Phase 1: zero-infrastructure RAG — done

| File | What it does |
| --- | --- |
| `server/standalone-profile.js` | Flips every switch needed to run with no database, in one place. Clearing `POSTGRES_DATABASE_URL` is the decisive lever; the rest is belt and braces so a stray `.env` cannot re-enable a subsystem with no database to talk to. |
| `server/rag/doc-registry-file.js` | File-backed document registry replacing the PostgreSQL one. Replicates access-scope semantics rather than skipping them. |
| `server/runtime-paths.js` | Single place deciding where user data lives. Falls back to the OS user-data directory when the install directory is not writable. |
| `server/rag/pdf-runtime-shim.js` | Makes `pdfjs-dist` survive being bundled into a single-file binary. |
| `server/archive-mcp-server.js` / `archive-mcp-tools.js` | Exposes the archive to opencode over MCP: `archive_ask`, `archive_list_documents`, `archive_refresh`. |
| `server/archive-ingest.mjs` | CLI ingest entry point. |

Verified end to end: a compiled binary, run from a directory with no `node_modules`
ancestry and **zero environment variables**, ingested two PDFs into
`~/Library/Application Support/DocCompare/rag`, and a separately compiled MCP binary
listed them back.

### Three real bugs found and fixed along the way

These were silently wrong — each produced plausible output rather than an error:

1. **BM25 orphan pollution** — a failed dense-index write left sparse entries behind,
   and those entries feed corpus-wide BM25 statistics, skewing scores for every other
   document. Now rolled back unconditionally.
2. **Cross-dimension scoring** — chunks embedded at a different dimension than the query
   scored `0.7071`, comfortably above the `0.32` relevance threshold, so a stale archive
   ranked garbage as evidence. Now guarded, with a deduplicated warning per shape.
3. **Lexical coverage vetoing every comparison** — query-term coverage is purely lexical,
   so naturally phrased comparison questions ("compare liability caps") measured 0.50
   against a 0.51 default and were rejected *before the model was ever called*. Every
   phrasing measured failed. The bypass is scoped to comparison only, because in
   single-document QA low coverage carries real information (it marks a chunk answering
   only part of a multi-aspect question) — relaxing it globally made a correct abstention
   disappear.

### Test and gate state

Measured at this commit (`9ff98d54`). No artifact is committed for either — the result
files are gitignored, so re-run to reproduce:

`cd server && npm test` → **1205 tests, 0 failures.**
`cd server && npm run coverage:gate` → **exit 0, all 5 enforced contexts pass.** Note this
is the *minimums* gate. The separate aspirational `coverage:targets` still reports 2 warns
(RAG/AgentRAG core branch, Rerank/retrieval branch) — pre-existing, not introduced here.

The PostgreSQL web deployment was reviewed for regressions from this work by reading the
affected code paths across several lenses, and none were found. That was **code review, not
executed tests** — no live database was involved, and no audit artifact survives.

---

## The one thing blocking everything

> **Update 2026-09-25 (on `main`):** measured with local Ollama (`nomic-embed-text` +
> `qwen2.5:7b`). `verify:quality` first scored 16/18 with both comparison checks
> abstaining, and the cause was the claim check, not the model: grouped citations such as
> `[Source 1, Source 3]` were not parsed, and `vendor-a.pdf` was not recognised as a
> document label, so the two per-document difference bullets could never pair. After
> `f7f6690c` it scores 18/18, and so does the self-test. The passing comparison comes from
> the engine's grounded fallback; a model-written paraphrase is still rejected by the
> lexical claim check. Real-embedding retrieval numbers are in
> `server/docs/interview/CURRENT-TRUTH.md`. The Phase 2/3 decision is no longer blocked on
> measurement, but a 7B model remains a capability ceiling. The text below is the original
> 2026-08-24 analysis, kept for its reasoning.

**Answer quality had never been measured with a real model (as of 2026-08-24).** Every test to date runs a
deterministic hashed bag-of-words stub embedder. That proves the plumbing is connected and
proves nothing about whether retrieval finds the right text or the comparison binds each
value to the right document.

Phase 2 (rebranding) and Phase 3 (packaging) add **zero functionality** — they are pure
branding and distribution cost. Do not spend on them until quality is measured. If the CLI
shape turns out to be worth less than expected, the right move is to stop before paying
the rename and release costs and pivot to the GUI.

### The harness that closes this gap exists and works

```bash
cd server
OPENAI_API_KEY=... npm run verify:quality
```

`server/evaluation/run-doccompare-verification.mjs` — 18 checks over five paths:
single-document QA with page-accurate citations, two-document comparison, an
identical-pair control, out-of-corpus abstention, and a second process reading the same
archive. Full runbook in `docs/evaluation.md` under "DocCompare quality verification".

Needs only a non-empty `OPENAI_API_KEY` and no PostgreSQL. Works against any
OpenAI-compatible endpoint (`rag/openai-client.js` honours `OPENAI_BASE_URL` /
`OPENAI_API_BASE`), so local Ollama needs no paid key:

```bash
cd server
OPENAI_API_KEY=ollama \
OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \
OPENAI_EMBEDDING_MODEL=nomic-embed-text \
OPENAI_CHAT_MODEL=qwen2.5:7b \
npm run verify:quality
```

Requires `ollama pull nomic-embed-text` and `ollama pull qwen2.5:7b`. **Use 7b, not 3b** —
the comparison path requires binding each value to the correct document, and a 3B model
tends to cross-attribute there. That would be a model-capability failure reported as a
product failure.

**Why the grader is not trivially satisfiable.** Preserve these two controls if the
harness is ever edited:

- A system that **always abstains** would pass every abstention check. So abstention only
  counts as meaningful when the answer paths produced answers, and that cross-check is
  recorded as its own check (`meta.abstention-is-discriminating`) rather than left as
  prose.
- A system that **always claims to find differences** would sail through a comparison
  test. So a byte-identical `policy-v1.pdf` / `policy-v2.pdf` pair is included, and
  inventing a divergence there fails.

Page numbers are checked against fixture ground truth, not checked for presence:
`server/evaluation/build-doccompare-fixtures.mjs` knows which page every sentence is on,
so a citation naming the wrong page is caught. The liability clause sits on page 2
specifically so a system that always answers "page 1" fails. Checked once, ad hoc, that all
four fixtures parse at the expected page counts through the real PDF loader and that the
clause really does extract from page 2. That check was a throwaway script and is not
committed, so treat it as a claim to re-establish rather than as standing evidence.

The strictest check is `compare.value-binding`: 12 months must bind to Vendor A and 6
months to Vendor B, with no statement about one carrying the other's value. A confident
but cross-attributed answer is worse than no answer and reads exactly like a correct one.

### Self-test scored 16/18 — now 18/18, and it was never "by design"

> **Correction 2026-09-25:** the two failures below were attributed to the stand-in model.
> They were caused by the two claim-check bugs described in the update above, and the
> self-test has passed 18/18 since `f7f6690c`. The open question at the end of this section
> is answered: it was not the 3-page fixtures, it was the `vendor-a` / `vendor-b` file names.

```bash
cd server && node evaluation/run-doccompare-verification.mjs --self-test
```

Runs the whole harness offline on the repo's deterministic provider, so a crash in the
harness is not discovered on someone's first real run. `compare.answers` and
`compare.value-binding` fail. Self-test output is written to
`latest-doccompare-selftest.*` so it can never overwrite a real report.

**Read the reason for those two failures carefully — an earlier version of this document
got it wrong.** The comparison answer has three stages (`server/rag/answer-writer.js`,
~923-957): use the model's text if it passes `isSafeStructuredDifferenceAnswer`, else fall
back to an engine-constructed `buildGroundedDifferenceAnswer`, else abstain. In the
self-test *both* the stand-in's text and the engine's grounded fallback failed that check,
so it abstained — and the harness correctly reported a failure rather than passing a fake.

Do **not** claim this is covered elsewhere. The nearby test "the MCP ask tool carries a
real comparison summary onto the wire" (`server/test/rag.test.mjs`) runs under the
file-wide stub provider, whose `completeText` returns hand-written canned strings; it
asserts only engine-derived structured fields (`comparedDocIds`, `evidenceBalance`,
`explicitConflictPairs`) plus citations. It genuinely covers the comparison **engine** and
the MCP serialization seam. It does **not** demonstrate that a model writes a correct
comparison, and its name overstates what it checks.

So a full pass is expected only against a real model, and whether a real model clears
`isSafeStructuredDifferenceAnswer` on these fixtures **is unmeasured**. Open question worth
answering when the first real run happens: if the comparison still abstains with a
competent model, investigate why `buildGroundedDifferenceAnswer` declines on 3-page
fixtures when it succeeds on the 1-page ones in the unit test — that would be a real
product finding, not a harness artifact.

---

## Next action

1. ~~Install Ollama and pull the two models above~~ Done 2026-09-25 (or supply a real API key —
   then the 7B capability ceiling goes away).
2. ~~Run `npm run verify:quality`~~ Done: 18/18 after `f7f6690c`.
3. **Only then** decide whether Phase 2/3 is worth the investment.

---

## Known unverified / open items

Stated plainly so nobody mistakes them for done:

- ~~**Answer quality with a real model**~~ Measured locally with a 7B model (18/18); not yet
  with a frontier model.
- **A model-written comparison passing `isSafeStructuredDifferenceAnswer`** — still not
  seen: the comparison now answers through the engine's grounded fallback, and a
  paraphrasing model's own text is rejected by the lexical claim check.
- **Cross-compiled binaries were built but never executed.** linux-x64, linux-arm64,
  windows-x64 and darwin-x64 were produced; only the native macOS build was ever run.
- **The PostgreSQL path was never run against a live database** in this work. The
  regression review read code rather than executing anything.
- **`quality:current` was never run** on this branch.
- Phase 2/3 not started.

## Traps worth knowing before editing

- **`server/rag/pdf-loader.js` import order is load-bearing.** The shim must be imported
  *before* `pdfjs`. A formatter that sorts imports breaks bundled builds.
- **`RAG_DATA_DIRECTORY` is captured at import time** by `rag/storage.js`, and
  `vector-store-local.js` loads its index at import time. Anything setting the data
  directory must do so *before* the first RAG import — which is why the verification
  harness uses dynamic imports throughout.
- **The coverage gate has a stale-exclusion check.** A path listed in
  `GLOBAL_COVERAGE_EXCLUDED_PATHS` must be git-tracked, so a new excluded file has to be
  `git add`ed before the gate will pass. This bites when splitting work across commits.
- **`runtime-paths.js` rule order is load-bearing.** As root on Linux `/` is writable, so
  a writability-only rule would create a literal `$bunfs` directory at filesystem root.
- MCP is wired in `.opencode/opencode.json` as `node server/archive-mcp-server.js`. The
  server only applies the zero-infrastructure profile when `DOCCOMPARE_STANDALONE=1`;
  without it, existing PostgreSQL behaviour is unchanged. That branch is what keeps the
  web workbench unaffected.

## Scratch state outside the repo

Not required to continue, but it exists and saves rebuild time:

- `/tmp/oc-src` — 219MB shallow opencode clone, needed for Phase 2. `/tmp` has been wiped
  once already; re-clone if gone.
- `/tmp/dc-verify` — probe scripts and the cross-compiled binaries.
- `~/.doccompare-verify-backup` — backup of the probe harness, kept because `/tmp` is not
  durable.
