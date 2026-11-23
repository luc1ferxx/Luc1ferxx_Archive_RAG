---
description: Compare archived PDFs and report page-cited differences
agent: doccompare
---

Compare documents from the PDF archive: $ARGUMENTS

Steps:

1. Call `archive_list_documents` to see what is available, unless the request
   already names docIds.
2. Identify which documents to compare. If it is ambiguous, ask before comparing.
3. Call `archive_ask` once, passing **all** the docIds together with a question
   worded as a comparison (for example "compare" or "difference"), so the archive
   runs its comparison path (per-document retrieval plus evidence alignment).
4. Report organised by point of difference — each point with both sides' position
   and its citation (`fileName`, page number, excerpt). Say so explicitly when a
   document is silent on a point rather than treating silence as agreement.
5. If `abstained` is true, report `abstainReason` verbatim instead of a
   comparison, and suggest narrowing the question or adding the missing document
   (`npm run archive:ingest -- <file.pdf>` from `server/`, or the web workbench)
   followed by `archive_refresh`.

Do not compare by asking about each document separately and diffing the answers
yourself, and do not cite any page that is not in the returned citations.
