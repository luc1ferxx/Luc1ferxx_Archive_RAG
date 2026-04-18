# Synthetic RAG Evaluation

- Run ID: `2026-04-18T01-33-03-319Z`
- Corpus file: `C:\Users\Jxx\Desktop\agentai\server\evaluation\synthetic-corpus-hybrid.json`
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
| Overall pass rate | 0.75 |
| QA page hit rate | 1 |
| Compare doc coverage | 1 |
| Compare page hit rate | 1 |
| Abstain accuracy | 0 |
| Answer content hit rate | 1 |
| Upload resume success rate | 1 |
| Avg response time (ms) | 7421.13 |
| Avg citation count | 4.63 |
| Resume saved bytes | 2700 |

## Upload Resume Checks

| Document | Chunks | Skipped On Resume | Saved Bytes | Merge OK |
| --- | ---: | ---: | ---: | --- |
| catalog-alpha.pdf | 10 | 5 | 900 | yes |
| catalog-beta.pdf | 10 | 5 | 900 | yes |
| catalog-gamma.pdf | 10 | 5 | 900 | yes |

## Case Results

| Case | Type | Pass | Abstain | Doc Hit | Page Hit | Answer Hit | Time (ms) |
| --- | --- | --- | --- | --- | --- | --- | ---: |
| qa_nulpar_bq_beta | qa | yes | no | yes | yes | yes | 2556 |
| qa_nulpar_cr_gamma | qa | yes | no | yes | yes | yes | 2681 |
| compare_nulpar_bq | compare | yes | no | yes | yes | yes | 11777 |
| compare_nulpar_cr | compare | yes | no | yes | yes | yes | 8955 |
| qa_badge_window_beta | qa | yes | no | yes | yes | yes | 3396 |
| compare_badge_window | compare | yes | no | yes | yes | yes | 11579 |
| qa_nulpar_dz_abstain | qa | no | no | no | no | yes | 5007 |
| compare_nulpar_dz_abstain | compare | no | no | no | no | yes | 13418 |

## Failures

### qa_nulpar_dz_abstain

- Question: What is the NULPAR-DZ allocation amount?
- Answer: Insufficient evidence: the retrieved sources mention only NULPAR-AX, NULPAR-BQ, and NULPAR-CR; none include NULPAR-DZ, so I cannot determine its allocation amount.
- Answer hit: yes
- Citations: catalog_alpha p.1, catalog_alpha p.2, catalog_alpha p.3

### compare_nulpar_dz_abstain

- Question: Compare the NULPAR-DZ allocation amount in these documents.
- Answer: Summary:
No document provides an allocation amount for NULPAR-DZ. Each document lists allocations for other NULPAR programs (AX, BQ, and/or CR), but NULPAR-DZ is not mentioned.

Per document:
- catalog-alpha.pdf: No evidence of NULPAR-DZ. Only NULPAR-AX (180 dollars), NULPAR-BQ (260 dollars), and NULPAR-CR (340 dollars) are listed (Source 1; Source 4; Source 7).
- catalog-beta.pdf: No evidence of NULPAR-DZ. Only NULPAR-AX (190 dollars), NULPAR-BQ (270 dollars), and NULPAR-CR (350 dollars) are listed (Source 2; Source 5; Source 8).
- catalog-gamma.pdf: No evidence of NULPAR-DZ. Only NULPAR-AX (200 dollars) and NULPAR-BQ (280 dollars) are listed (Source 3; Source 6).

Agreements:
- All documents lack any mention of NULPAR-DZ allocation amount (in the provided evidence).

Differences:
- None related to NULPAR-DZ; differences only exist for AX/BQ/CR amounts across documents (Sources 1–8), which are not evidence for DZ.

Gaps or uncertainty:
- The allocation amount for NULPAR-DZ cannot be determined from the provided evidence. If NULPAR-DZ exists, it may be documented elsewhere not included in these excerpts.
- Answer hit: yes
- Citations: catalog_alpha p.1, catalog_beta p.3, catalog_gamma p.4, catalog_alpha p.2, catalog_beta p.4, catalog_gamma p.2, catalog_alpha p.3, catalog_beta p.1

