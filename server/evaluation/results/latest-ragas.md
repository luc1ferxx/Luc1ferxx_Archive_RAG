# Ragas Evaluation

- Created: `2026-04-21T20:45:10.864664+00:00`
- Input file: `C:\Users\Jxx\Desktop\agentai\server\evaluation\results\latest.json`
- Source run ID: `2026-04-21T20-42-35-142Z`
- Judge model: `gpt-4o-mini`
- Embedding model: `text-embedding-3-small`
- Eligible cases: `6` / `8`

## Route Summaries

| Route | Cases | Answer Relevancy | Faithfulness | Context Utilization | Context Precision | Context Recall | Compare Rubric |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| overall | 6 | 0.6171 | 0.8 | 1.0 | 1.0 | 0.8333 | 0.95 |
| qa | 2 | 0.6724 | 1.0 | 1.0 | 1.0 | 1.0 | None |
| compare | 4 | 0.5895 | 0.7 | 1.0 | 1.0 | 0.75 | 0.95 |

## QA Cases

| Case | Answer Relevancy | Faithfulness | Context Utilization | Context Precision | Context Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| qa_remote_alpha | 0.6261 | 1.0 | 1.0 | 1.0 | 1.0 |
| qa_badge_gamma | 0.7187 | 1.0 | 1.0 | 1.0 | 1.0 |

## Compare Cases

| Case | Compare Rubric | Answer Relevancy | Faithfulness | Context Utilization | Context Precision | Context Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| compare_remote_no_material_difference_2way | 1.0 | 0.4196 | 0.4 | 1.0 | 1.0 | 0.5 |
| compare_remote_no_material_difference_3way | 1.0 | 0.4226 | 0.4 | 1.0 | 1.0 | 0.5 |
| compare_remote_numeric_conflict | 1.0 | 0.7563 | 1.0 | 1.0 | 1.0 | 1.0 |
| compare_remote_mixed_duplicate_conflict | 0.8 | 0.7593 | 1.0 | 1.0 | 1.0 | 1.0 |

## Compare Judge Notes

### compare_remote_no_material_difference_2way

- Score: 1.0
- Verdict: The candidate answer correctly identifies the lack of differences and provides a summary of the key facts.
- Strengths: Accurately covers key facts from both documents.
- Issues: Could emphasize the conclusion of no material differences more clearly.

### compare_remote_no_material_difference_3way

- Score: 1.0
- Verdict: The candidate answer accurately identifies the lack of material differences among the documents.
- Strengths: Accurately summarizes key points of agreement from retrieved contexts.
- Issues: Minor repetition present in stating no differences found.

### compare_remote_numeric_conflict

- Score: 1.0
- Verdict: The candidate answer correctly identifies the similarities and differences between the documents.
- Strengths: Accurately captures key similarities and differences in remote work policies.
- Issues: Minor redundancy in stating manager approval multiple times.

### compare_remote_mixed_duplicate_conflict

- Score: 0.8
- Verdict: The candidate answer effectively compares the documents but has minor redundancies.
- Strengths: Correctly identifies manager approval and security checklist requirements across all documents.; Clearly distinguishes between the remote work days allowed.
- Issues: Some redundancy in stating requirements for manager approval and checklists.

## Skipped Cases

- `qa_satellite_stipend_abstain`: No retrieved_contexts were captured.
- `compare_remote_single_doc_abstain`: Abstain case skipped by default.
