# Synthetic RAG Evaluation

- Run ID: `2026-04-20T20-18-37-746Z`
- Corpus file: `C:\Users\Jxx\Desktop\agentai\server\evaluation\synthetic-corpus-near-duplicate.json`
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
| Overall pass rate | 0.875 |
| QA page hit rate | 1 |
| Compare doc coverage | 1 |
| Compare page hit rate | 1 |
| Abstain accuracy | 1 |
| Answer content hit rate | 0.8333 |
| Upload resume success rate | 1 |
| Avg response time (ms) | 11059 |
| Avg citation count | 1.63 |
| Resume saved bytes | 2700 |

## Upload Resume Checks

| Document | Chunks | Skipped On Resume | Saved Bytes | Merge OK |
| --- | ---: | ---: | ---: | --- |
| handbook-alpha.pdf | 7 | 3 | 540 | yes |
| handbook-beta.pdf | 7 | 3 | 540 | yes |
| handbook-gamma.pdf | 7 | 3 | 540 | yes |
| handbook-epsilon.pdf | 7 | 3 | 540 | yes |
| travel-manual.pdf | 6 | 3 | 540 | yes |

## Case Results

| Case | Type | Pass | Abstain | Doc Hit | Page Hit | Answer Hit | Time (ms) |
| --- | --- | --- | --- | --- | --- | --- | ---: |
| qa_remote_alpha | qa | no | no | yes | yes | no | 3392 |
| qa_badge_gamma | qa | yes | no | yes | yes | yes | 5812 |
| compare_remote_no_material_difference_2way | compare | yes | no | yes | yes | yes | 335 |
| compare_remote_no_material_difference_3way | compare | yes | no | yes | yes | yes | 134 |
| compare_remote_numeric_conflict | compare | yes | no | yes | yes | yes | 52481 |
| compare_remote_mixed_duplicate_conflict | compare | yes | no | yes | yes | yes | 25874 |
| qa_satellite_stipend_abstain | qa | yes | yes | yes | yes | yes | 256 |
| compare_remote_single_doc_abstain | compare | yes | yes | yes | yes | yes | 188 |

## Failures

### qa_remote_alpha

- Question: What is the remote work policy?
- Answer: - Employees may work remotely two days per week with manager approval [Source 1].  
- Security checklists must be completed before each remote day [Source 1].
- Answer hit: no
- Citations: handbook_alpha p.1

