# Ragas Evaluation

- Created: `2026-04-21T21:02:41.264348+00:00`
- Input file: `C:\Users\Jxx\Desktop\agentai\server\evaluation\results\compare-hard.json`
- Source run ID: `2026-04-21T20-11-33-312Z`
- Judge model: `gpt-4o-mini`
- Embedding model: `text-embedding-3-small`
- Eligible cases: `7` / `8`

## Route Summaries

| Route | Cases | Answer Relevancy | Faithfulness | Context Utilization | Context Precision | Context Recall | Compare Rubric |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| overall | 7 | 0.6658 | 0.8939 | 0.9286 | 1.0 | 0.8571 | 0.9333 |
| qa | 1 | 0.606 | 1.0 | 1.0 | 1.0 | 1.0 | None |
| compare | 6 | 0.6758 | 0.8762 | 0.9167 | 1.0 | 0.8333 | 0.9333 |

## QA Cases

| Case | Answer Relevancy | Faithfulness | Context Utilization | Context Precision | Context Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| qa_remote_alpha_hard_control | 0.606 | 1.0 | 1.0 | 1.0 | 1.0 |

## Compare Cases

| Case | Compare Rubric | Answer Relevancy | Faithfulness | Context Utilization | Context Precision | Context Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| compare_remote_exact_duplicate_no_diff_hard | 1.0 | 0.4196 | 0.4 | 1.0 | 1.0 | 0.6667 |
| compare_remote_paraphrase_no_diff_hard | 1.0 | 0.7563 | 1.0 | 1.0 | 1.0 | 0.3333 |
| compare_remote_numeric_conflict_hard | 0.9 | 0.606 | 1.0 | 0.5 | 1.0 | 1.0 |
| compare_remote_scope_conflict_hard | 0.9 | 0.6841 | 1.0 | 1.0 | 1.0 | 1.0 |
| compare_remote_approval_conflict_hard | 1.0 | 0.8046 | 0.8571 | 1.0 | 1.0 | 1.0 |
| compare_remote_mixed_duplicate_conflict_hard | 0.8 | 0.7842 | 1.0 | 1.0 | 1.0 | 1.0 |

## Compare Judge Notes

### compare_remote_exact_duplicate_no_diff_hard

- Score: 1.0
- Verdict: The candidate answer accurately identifies no material differences, but lacks depth in articulating the comparison.
- Strengths: Identified agreement on remote work policy details.
- Issues: Could have elaborated on the reasoning for no material differences.

### compare_remote_paraphrase_no_diff_hard

- Score: 1.0
- Verdict: The candidate answer effectively summarizes the main agreements and acknowledges slight wording variations.
- Strengths: Accurately captures main agreements between documents; Identifies slight variations in wording
- Issues: Minor redundancy in phrasing 'both documents allow up to 2 days of remote work per week' and 'limit of 2 remote days per week'

### compare_remote_numeric_conflict_hard

- Score: 0.9
- Verdict: The candidate answer effectively captures the main agreements and differences between the documents.
- Strengths: Accurately identifies the requirement for manager approval and security checklists.; Clearly distinguishes between the number of remote days allowed in each policy.
- Issues: Repeated information about manager approval and security checklists, which could be more concise.

### compare_remote_scope_conflict_hard

- Score: 0.9
- Verdict: The candidate answer accurately captures the main agreements and differences between the documents.
- Strengths: Clearly states agreement on remote work days and security requirements.; Correctly identifies eligibility restriction in delta handbook.
- Issues: Minor redundancy in stating remote work limitations.

### compare_remote_approval_conflict_hard

- Score: 1.0
- Verdict: The candidate answer accurately captures the main agreements and differences in the remote work policies.
- Strengths: Correctly identifies remote work days and security checklist requirement.
- Issues: Minor redundancy in stating remote days and checklist requirements.

### compare_remote_mixed_duplicate_conflict_hard

- Score: 0.8
- Verdict: The candidate answer is mostly accurate but lacks clarity in summarizing the main differences.
- Strengths: Correctly identifies manager approval and security checklist requirements for all three policies.
- Issues: Could better emphasize the key difference of remote work days allowed between the documents.

## Skipped Cases

- `compare_remote_unrelated_abstain_hard`: Abstain case skipped by default.
