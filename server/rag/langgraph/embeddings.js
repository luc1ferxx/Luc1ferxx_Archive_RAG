import { Embeddings } from "@langchain/core/embeddings";

import { embedQueryCached } from "../embedding-cache.js";
import { embedTexts } from "../openai.js";
import { embedDocumentsInSpace } from "../vector-store-pgvector.js";
import { assertLangSmithTracingDisabled } from "./langsmith-guard.js";

// LangChain's Embeddings interface over this project's own embedding path
// (docs/adr/0001-langgraph-runtime.md, phase 1). It is a pass-through: every
// decision that makes a vector what it is stays where it already lives.
//
// - Queries go through embedQueryCached (embedding-cache.js): the space the
//   index serves (or the pinned `space`), the task prefix, the per-process LRU
//   with in-flight dedupe, and the space tag getQueryVectorEmbeddingSpace reads.
//   The cached vector object itself is returned, never a copy, because the tag
//   and the query adapter's model mark (query-adapter.js) are WeakMap entries
//   keyed by that object; a copy would search as an untagged, unadapted vector.
// - Documents go through embedTexts (openai.js) with the configured document
//   prefix, exactly as the local and Qdrant ingest paths call it, or, for a
//   pinned `space`, through embedDocumentsInSpace (vector-store-pgvector.js),
//   the index-version path that decides between the configured route and an
//   explicit `embeddingSpace` and checks the space's width.
//
// Either way the call reaches openai.js, which owns retries, backoff, the
// model-call guard (concurrency cap and circuit breaker), the model gateway,
// failover and LLMOps metering. LangChain's own AsyncCaller (`this.caller`) is
// built with maxRetries 0 and no maxConcurrency and is never used: its retries
// would stack on openai.js's, and a finite concurrency would queue a call to
// start later inside whichever request's AsyncLocalStorage context freed the
// slot (tenant, deadline, run usage), as the phase 0 spike measured.
//
// The asymmetry when no space is given is the production one: a query is
// embedded in the space the index serves (the active pgvector version's), a
// document in the configured space (what a new ingest writes). Pass `space` to
// pin both to one space.

const assertEmbeddingSpace = (space) => {
  if (space !== null && (typeof space !== "object" || Array.isArray(space))) {
    const error = new TypeError("ArchiveRagEmbeddings `space` must be an embedding space object or null.");

    error.code = "LANGGRAPH_EMBEDDINGS_SPACE_INVALID";
    throw error;
  }
};

export class ArchiveRagEmbeddings extends Embeddings {
  #space;

  constructor({ space = null } = {}) {
    // Before super(): nothing of LangChain is constructed while LangSmith
    // tracing is switched on.
    assertLangSmithTracingDisabled();
    assertEmbeddingSpace(space);
    super({ maxRetries: 0 });
    this.#space = space;
  }

  /** The pinned embedding space, or null for the serving / configured space. */
  get space() {
    return this.#space;
  }

  async embedQuery(text) {
    assertLangSmithTracingDisabled();

    return embedQueryCached(text, { space: this.#space });
  }

  async embedDocuments(texts) {
    assertLangSmithTracingDisabled();

    return this.#space === null ? embedTexts(texts) : embedDocumentsInSpace(texts, this.#space);
  }
}
