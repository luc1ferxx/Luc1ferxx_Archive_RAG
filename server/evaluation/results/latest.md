# Synthetic RAG Evaluation

- Run ID: `2026-04-13T06-58-38-397Z`
- Embedding model: `text-embedding-3-small`
- Chat model: `gpt-5`
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
| Upload resume success rate | 1 |
| Avg response time (ms) | 9254 |
| Avg citation count | 2 |
| Resume saved bytes | 2160 |

## Upload Resume Checks

| Document | Chunks | Skipped On Resume | Saved Bytes | Merge OK |
| --- | ---: | ---: | ---: | --- |
| benefits-2024.pdf | 8 | 4 | 720 | yes |
| benefits-2025.pdf | 8 | 4 | 720 | yes |
| travel-guide.pdf | 8 | 4 | 720 | yes |

## Case Results

| Case | Type | Pass | Abstain | Doc Hit | Page Hit | Time (ms) |
| --- | --- | --- | --- | --- | --- | ---: |
| qa_leave_2024 | qa | yes | no | yes | yes | 2807 |
| qa_remote_2025 | qa | yes | no | yes | yes | 2821 |
| qa_meal_2024 | qa | yes | no | yes | yes | 10401 |
| compare_leave | compare | yes | no | yes | yes | 20002 |
| compare_remote | compare | yes | no | yes | yes | 10104 |
| compare_meal_limit | compare | yes | no | yes | yes | 9356 |
| qa_parental_leave_abstain | qa | no | no | no | no | 6284 |
| compare_hotel_policy_abstain | compare | no | no | yes | yes | 12257 |

## Failures

### qa_parental_leave_abstain

- Question: What is the parental leave policy?
- Answer: The retrieved evidence does not include a parental leave policy.  
It only covers annual leave (10 paid days; no carryover) and remote work (2 days/week with manager approval) (Source 1; Source 2).  
Please provide the relevant document or location for the parental leave policy so I can confirm the details.
- Citations: benefits_2024 p.1, benefits_2024 p.2

### compare_hotel_policy_abstain

- Question: Compare the hotel reimbursement policy in these documents.
- Answer: Summary:
- Only travel-guide.pdf states a hotel reimbursement policy: capped at 180 dollars per night and requires manager approval (Source 2).
- benefits-2025.pdf does not state any hotel reimbursement terms; it only mentions a meal limit of 60 dollars per day (Source 1).

Per document:
- benefits-2025.pdf: No hotel reimbursement policy found. Mentions meal reimbursement limit of 60 dollars per day (Source 1).
- travel-guide.pdf: Hotel reimbursement capped at 180 dollars per night; manager approval is required (Source 2).

Agreements:
- None on hotel reimbursement. Only one document specifies hotel terms.

Differences:
- Scope: travel-guide.pdf covers hotel reimbursement with a cap and approval requirement (Source 2); benefits-2025.pdf is silent on hotel reimbursement and instead specifies a meal limit (Source 1).

Gaps or uncertainty:
- Whether benefits-2025.pdf contains any hotel policy elsewhere or intends to defer to the travel guide.
- Whether the 180 dollars per night cap includes taxes/fees or varies by location (not specified in Source 2).
- Whether manager approval is required for all hotel reimbursements or only in specific cases (Source 2 does not clarify).
- Citations: benefits_2025 p.3, travel_guide p.1

