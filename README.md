# Luc1ferxx Archive

Luc1ferxx Archive is a multi-document RAG workspace built with React and Node.js. It is designed for a workflow where users upload multiple PDFs, ask grounded questions against those documents, compare document-backed answers with live web-search results, inspect citations in an inline PDF preview, and switch into a compare-aware retrieval path when the query is asking for differences or agreements across documents.

What makes this project more than a basic LangChain demo is that LangChain is used as the infrastructure layer, while the retrieval and product logic are customized on top of it. The backend keeps LangChain for PDF loading, embeddings, and prompt orchestration, but adds its own persisted vector index, hierarchical chunking, compare-aware retrieval, evidence alignment, confidence gating, resumable uploads, and evaluation harnesses.

## What The System Does

This project lets a user upload one or more PDF files, ask document-grounded questions, inspect citations with file name and page number, preview the cited page inside the app, and compare document answers with a second answer generated from live web search results. It also supports a voice mode so the user can ask questions through speech input and hear the document-backed answer read aloud.

The document answer path and the web answer path run in parallel. The document path is optimized for grounded retrieval over the uploaded PDFs, while the web path uses a local MCP server backed by SerpAPI to summarize live search results. This separation makes it easy to contrast "what the uploaded documents say" against "what current web results say."

## Core Flow

The upload flow starts in the browser. A PDF is sliced into binary upload chunks so the frontend can support resumable upload behavior. The backend receives those upload chunks, stores them in an upload session, and merges them back into a complete PDF when all parts arrive. Only after the file is reconstructed does the ingestion pipeline begin.

The ingestion pipeline reads the reconstructed PDF with LangChain's `PDFLoader`, extracts page text, and passes each page through a custom chunker. The chunker preserves page-level structure and then splits content using headings, paragraphs, and sentence boundaries instead of relying on a plain fixed-character splitter. Each resulting chunk keeps metadata such as `docId`, `fileName`, `pageNumber`, `chunkIndex`, and `sectionHeading`. The chunks are then embedded with OpenAI embeddings and written into a persisted local vector index so the corpus survives backend restarts.

When the user asks a question, the backend first normalizes the selected `docIds` and verifies that those documents exist. It then routes the query into either a normal QA path or a compare path. The route decision is currently rule-based and uses comparison signals such as `compare`, `difference`, `vs`, `similar`, and `conflict`.

In the normal QA path, the system embeds the query, retrieves the top document chunks across the selected PDFs, runs a confidence gate, and, if enough grounded evidence exists, builds a prompt and asks GPT-5 to generate a concise grounded answer with citations.

In the compare path, the system does not simply retrieve a global top-k across all documents. Instead, it retrieves evidence per document, checks confidence across the selected documents, aligns evidence across documents, analyzes the comparison structure, and only then asks GPT-5 to write a structured comparison. The final answer is organized into sections such as summary, per-document findings, agreements, differences, and uncertainty.

## Why This Project Is Interesting

The project is intentionally built around a common failure mode of standard RAG systems: multi-document comparison. A typical RAG pipeline often performs a global top-k retrieval across all chunks, which makes it easy for one document to dominate the retrieved evidence. That behavior is acceptable for single-document QA, but it becomes unreliable for comparison tasks because the answer can look like a comparison while actually reflecting only one document.

This project addresses that problem by routing comparison questions into a dedicated compare-aware retrieval path. Instead of treating all chunks as one flat pool, it retrieves evidence per document, preserves document identity through the pipeline, and constructs a structured comparison prompt from aligned evidence. This makes the behavior easier to explain, easier to debug, and easier to evaluate than a naive "retrieve then hope the model compares correctly" design.

## Custom Logic On Top Of LangChain

LangChain is used here as the infrastructure layer. `PDFLoader` handles PDF parsing, `Document` objects provide a normalized document abstraction, `OpenAIEmbeddings` handles embedding requests, `ChatOpenAI` handles the final generation call, and `PromptTemplate` plus `ChatPromptTemplate` organize prompts.

The custom logic in this repository is the part that makes the project distinctive. The custom chunker uses page, heading, paragraph, and sentence structure to produce more stable retrieval units. The query router recognizes comparison-style questions and switches retrieval mode. The compare retriever preserves fairness across documents by retrieving per document instead of performing only a global ranking. The evidence aligner organizes retrieved evidence into a document-aware comparison bundle. The confidence layer decides whether the evidence is strong enough to answer or compare reliably. The upload subsystem adds chunked upload and resumable upload behavior that is independent of LangChain.

## Current Feature Set

The frontend supports multi-document upload, persisted document reloading, document deletion and clearing, question asking, voice input, TTS playback, side-by-side document and web answers, citation display, and inline PDF preview. The backend supports resumable uploads, persisted document and session state, compare-aware document retrieval, synthetic evaluation, a real-document evaluation entry point, and a local MCP-powered search path for live web answers.

The current local defaults are `text-embedding-3-small` for embeddings, `gpt-5` for answer generation, `v3` for the prompt version, `local` for the vector store provider, `structured` for the chunking strategy, `false` for hybrid retrieval, `900` for chunk size, `180` for chunk overlap, `6` for global retrieval top-k, `8` for sparse retrieval top-k, `3` for compare retrieval top-k per document, `0.32` for the minimum relevance score gate, and `0.51` for the minimum query-term coverage gate. These values can be changed through `server/.env`.

## Repository Structure

The frontend lives under `src/` and provides the upload interface, conversation UI, citation rendering, and PDF preview. The backend lives under `server/` and includes the Express API, the resumable upload subsystem, the RAG pipeline, and the MCP search integration. The custom RAG pipeline is organized under `server/rag/`, while the evaluation harness lives under `server/evaluation/`.

## Setup

Install the frontend dependencies from the repository root.

```powershell
cmd /c npm.cmd install
```

Install the backend dependencies from the `server` directory.

```powershell
cd server
cmd /c npm.cmd install
cd ..
```

Create `server/.env` from `server/.env.example` and fill in the required keys.

```env
OPENAI_API_KEY=your_openai_api_key
SERPAPI_KEY=your_serpapi_key
VECTOR_STORE_PROVIDER=local
QDRANT_URL=http://127.0.0.1:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=rag_chunks
QDRANT_DISTANCE=Cosine
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_CHAT_MODEL=gpt-5
RAG_PROMPT_VERSION=v3
RAG_CHUNK_STRATEGY=structured
RAG_HYBRID_ENABLED=false
RAG_HYBRID_DENSE_WEIGHT=0.65
RAG_HYBRID_SPARSE_WEIGHT=0.35
RAG_CHUNK_SIZE=900
RAG_CHUNK_OVERLAP=180
RAG_RETRIEVAL_TOP_K=6
RAG_SPARSE_TOP_K=8
RAG_COMPARE_TOP_K_PER_DOC=3
RAG_MIN_QUERY_TERM_COVERAGE=0.51
```

`OPENAI_API_KEY` is required for embeddings and answer generation. `SERPAPI_KEY` is required for the web-search answer path. `RAG_PROMPT_VERSION` supports `v1` for the legacy flat-string prompt, `v2` for the `system` plus `human` prompt layout, and `v3` for the structured follow-up rewrite prompt with JSON output. `server/.env` is ignored by git and should never be committed.

To enable true hybrid retrieval locally, keep the same chunking pipeline and set:

```env
RAG_HYBRID_ENABLED=true
RAG_HYBRID_DENSE_WEIGHT=0.65
RAG_HYBRID_SPARSE_WEIGHT=0.35
RAG_SPARSE_TOP_K=8
```

With hybrid retrieval enabled, the backend runs a dense embedding search and a BM25-style sparse search over the same chunks, then fuses the two result sets before confidence gating. Under the local provider those indices are persisted as JSON files. Under the Qdrant provider both dense and sparse vectors are stored in the same Qdrant collection.

To switch the vector store from local JSON persistence to Qdrant, start Qdrant locally and set `VECTOR_STORE_PROVIDER=qdrant`.

```powershell
docker run -p 6333:6333 qdrant/qdrant
```

The current Qdrant schema expects one named dense vector (`dense`) and one named sparse vector (`sparse`) per point. If you already have an older `rag_chunks` collection from a previous version of this repository, use a fresh collection name or clear that collection before re-ingesting documents.

## Running The Project

Start the frontend and backend together from the repository root.

```powershell
cmd /c npm.cmd run dev
```

Then open `http://localhost:3000`.

The default local ports are `3000` for the React frontend and `5001` for the Express backend.

## API Overview

`GET /documents` lists persisted documents. `DELETE /documents/:docId` removes one document from the registry, vector index, and uploads directory. `POST /documents/clear` clears all persisted documents. `DELETE /sessions/:sessionId` clears persisted follow-up memory for one session. `POST /upload/init` creates or resumes a chunked upload session. `GET /upload/status` returns the uploaded chunk indexes for a given file session. `POST /upload/chunk` accepts one upload chunk. `POST /upload/complete` merges the uploaded chunks into a complete PDF and triggers ingestion. `POST /upload` is still kept as a compatibility endpoint for direct single-file upload. `GET /chat` and `POST /chat` accept `question` plus `docId` or `docIds` and return `ragAnswer`, `ragSources`, `mcpAnswer`, and structured error fields.

## Evaluation

The repository includes a synthetic evaluation harness under `server/evaluation/`. The script generates a synthetic PDF corpus, simulates resumable upload behavior, ingests the documents, runs QA and comparison cases through the real RAG pipeline, and writes JSON and Markdown reports into `server/evaluation/results/`.

Run the synthetic evaluation with:

```powershell
cd server
cmd /c npm.cmd run eval:synthetic
```

Run the expanded 5-document synthetic stress corpus with:

```powershell
cd server
cmd /c npm.cmd run eval:synthetic -- evaluation/synthetic-corpus-5docs.json
```

Run the dedicated chunking comparison corpus with the current structured chunker:

```powershell
cd server
cmd /c "set VECTOR_STORE_PROVIDER=local&& set RAG_CHUNK_STRATEGY=structured&& set RAG_CHUNK_OVERLAP=180&& npm.cmd run eval:synthetic -- evaluation/synthetic-corpus-chunking.json"
```

Run the chunking comparison baseline with simple fixed-window chunking and no overlap:

```powershell
cd server
cmd /c "set VECTOR_STORE_PROVIDER=local&& set RAG_CHUNK_STRATEGY=simple&& set RAG_CHUNK_OVERLAP=0&& npm.cmd run eval:synthetic -- evaluation/synthetic-corpus-chunking.json"
```

Run a real-document evaluation by copying `server/evaluation/real-corpus.example.json` to your own corpus file, replacing the PDF paths and expectations, and then running:

```powershell
cd server
cmd /c npm.cmd run eval:real -- evaluation/real-corpus.json
```

### Optimization Benchmark

The clearest before/after improvement in this branch is the chunking upgrade on `evaluation/synthetic-corpus-chunking.json`. Both runs used the same retrieval top-k and compare top-k; the main change was moving from simple fixed windows with no overlap to the structured chunker with `180` overlap.

| Metric | Before: simple `900/0` | After: structured `900/180` |
| --- | ---: | ---: |
| Overall pass rate | 0.5 | 1 |
| QA page hit rate | 0.3333 | 1 |
| Compare doc coverage | 0.3333 | 1 |
| Compare page hit rate | 0.3333 | 1 |
| Answer content hit rate | 0.3333 | 1 |
| Upload resume success rate | 1 | 1 |
| Avg response time (ms) | 1310.63 | 3649.63 |
| Avg citation count | 0.5 | 1.5 |

This tradeoff is intentional. The structured chunker is slower because it keeps more grounded evidence in play, but the accuracy gain on both single-document QA and cross-document comparison is much larger than the latency increase.

The latest saved stress run in this repository is `server/evaluation/results/latest.*`, generated from `evaluation/synthetic-corpus-hybrid.json`. It currently reports an overall pass rate of `0.75`, a QA page hit rate of `1.0`, a compare document coverage rate of `1.0`, a compare page hit rate of `1.0`, an answer content hit rate of `1.0`, an upload resume success rate of `1.0`, and an abstain accuracy of `0.0`. In other words, retrieval coverage on the harder corpus is already stable, but abstention remains the weakest part of the pipeline.

## Current Limitations

The compare router is still keyword-based rather than model-based. The default local vector store is optimized for single-user workloads rather than large corpora, while the optional Qdrant provider requires a separately running Qdrant service. Compare responses can be slower than normal QA because the compare path performs per-document retrieval and then asks GPT-5 to write a structured answer over a larger prompt. The evaluation suite is useful and reproducible, but real-document validation still depends on you supplying your own corpus file and expected evidence.

## Security Notes

Do not commit `server/.env`. Do not commit private uploaded documents. The repository already ignores `server/uploads/`, upload logs, and generated evaluation PDFs. Use `server/.env.example` as the public configuration template.
