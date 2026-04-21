# Synthetic RAG Evaluation

- Run ID: `2026-04-21T20-11-33-312Z`
- Corpus file: `C:\Users\Jxx\Desktop\agentai\server\evaluation\synthetic-corpus-compare-hard.json`
- Embedding model: `text-embedding-3-small`
- Chat model: `gpt-5`
- Chunk strategy: `structured`
- Retrieval top-k: `6`
- Compare top-k per doc: `3`
- Chunk size / overlap: `900/180`
- Min relevance score: `0.32`

## Metrics

| Metric | Value |
| --- | ---: |
| Overall pass rate | 1 |
| QA page hit rate | 1 |
| Compare doc coverage | 1 |
| Compare page hit rate | 1 |
| Abstain accuracy | 1 |
| Answer content hit rate | 1 |
| Upload resume success rate | 1 |
| Avg response time (ms) | 16158.75 |
| Avg citation count | 1.88 |
| Resume saved bytes | 3780 |

## Upload Resume Checks

| Document | Chunks | Skipped On Resume | Saved Bytes | Merge OK |
| --- | ---: | ---: | ---: | --- |
| handbook-alpha.pdf | 7 | 3 | 540 | yes |
| handbook-beta.pdf | 7 | 3 | 540 | yes |
| handbook-gamma.pdf | 7 | 3 | 540 | yes |
| handbook-eta.pdf | 7 | 3 | 540 | yes |
| handbook-delta.pdf | 7 | 3 | 540 | yes |
| handbook-zeta.pdf | 7 | 3 | 540 | yes |
| travel-manual.pdf | 6 | 3 | 540 | yes |

## Case Results

| Case | Type | Pass | Abstain | Doc Hit | Page Hit | Answer Hit | Time (ms) |
| --- | --- | --- | --- | --- | --- | --- | ---: |
| qa_remote_alpha_hard_control | qa | yes | no | yes | yes | yes | 3711 |
| compare_remote_exact_duplicate_no_diff_hard | compare | yes | no | yes | yes | yes | 147 |
| compare_remote_paraphrase_no_diff_hard | compare | yes | no | yes | yes | yes | 20475 |
| compare_remote_numeric_conflict_hard | compare | yes | no | yes | yes | yes | 18692 |
| compare_remote_scope_conflict_hard | compare | yes | no | yes | yes | yes | 20742 |
| compare_remote_approval_conflict_hard | compare | yes | no | yes | yes | yes | 25788 |
| compare_remote_mixed_duplicate_conflict_hard | compare | yes | no | yes | yes | yes | 39543 |
| compare_remote_unrelated_abstain_hard | compare | yes | yes | yes | yes | yes | 172 |
