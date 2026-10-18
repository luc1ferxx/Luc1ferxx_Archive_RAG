import { extractMeaningfulTokens } from "./text-utils.js";

// The terms one sparse (BM25 / full-text) query scores: its distinct
// meaningful tokens, in the order they first appear, at most
// SPARSE_MAX_QUERY_TERMS of them. Without a cap a long question (or a
// retrieval-tier query of up to RETRIEVAL_SERVICE_MAX_QUERY_CHARS) scored
// thousands of terms: an OR tsquery the GIN index and the BM25 statistics are
// probed for term by term on pgvector, and a pass over every candidate chunk
// per term in the local store. A question names its subject early, so the
// first terms are kept. Both the pgvector route (vector-store-pgvector.js
// buildTsQuery) and the local BM25 store (sparse-store.js) select terms here,
// so their scores agree for a query of any length.
export const SPARSE_MAX_QUERY_TERMS = 64;

export const selectSparseQueryTerms = (queryText) =>
  [...new Set(extractMeaningfulTokens(queryText))].slice(0, SPARSE_MAX_QUERY_TERMS);
