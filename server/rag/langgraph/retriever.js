import { Document } from "@langchain/core/documents";
import { BaseRetriever } from "@langchain/core/retrievers";

import {
  retrieveGlobalContextForQueries,
  retrievePerDocumentContextForQueries,
} from "../document-rag-execution.js";
import { buildRetrievalQueries } from "../query-decomposer.js";
import { assertLangSmithTracingDisabled, guardRunnableEntryPoints } from "./langsmith-guard.js";

// LangChain's retriever interface over the document RAG retrieval seam
// (docs/adr/0001-langgraph-runtime.md, phase 1, constraint 8: retrieval keeps
// its implementation and only gets a thin wrapper).
//
// One query string becomes one call of the seam's dispatcher,
// retrieveGlobalContextForQueries or retrievePerDocumentContextForQueries
// (document-rag-execution.js), so the retriever reaches whatever this process
// would: the vector store in process (dense + sparse, fusion, rerank, query
// adapter, embedding cache) or the retrieval tier when RETRIEVAL_SERVICE_URL
// moves retrieval there. The call is the retrieval tier's own shape for a
// one-query plan: the primary requirement buildRetrievalQueries makes, and no
// precomputed vector, so the seam embeds the query through embedQueryCached in
// the space its index serves (in process) or sends only text (remotely).
//
// The tenant and the documents are the runtime's, never the model's: the
// access scope, docIds, retrieval options and query-adapter scope are fixed
// when the retriever is built, and the query string only chooses what to look
// for inside them. A query that names another document's id or quotes its
// text still searches the constructor's docIds under the constructor's scope.
//
// Results become LangChain Documents without losing anything: pageContent is
// the chunk text, the chunk's own metadata (docId, fileName, pageNumber, ...)
// sits at the top of `metadata` where LangChain consumers look for it, and the
// whole result minus its text sits under RETRIEVAL_RESULT_METADATA_KEY, so
// toRetrievalResults gives back objects deepStrictEqual to the seam's (and
// byte-identical when serialized). What the LangChain interface cannot carry
// is the per-call `retrieval` summary (routes, candidate counts); a caller
// that reports it calls the dispatcher itself and maps the results with
// toRetrieverDocuments / toPerDocumentRetrieverDocuments.

export const ARCHIVE_RAG_RETRIEVER_MODES = Object.freeze({
  global: "global",
  perDocument: "per_document",
});

export const RETRIEVAL_RESULT_METADATA_KEY = "archiveRagRetrievalResult";

export const LANGGRAPH_RETRIEVER_ERROR_CODES = Object.freeze({
  docIdsInvalid: "LANGGRAPH_RETRIEVER_DOC_IDS_INVALID",
  documentInvalid: "LANGGRAPH_RETRIEVER_DOCUMENT_INVALID",
  modeInvalid: "LANGGRAPH_RETRIEVER_MODE_INVALID",
  queryAdapterScopeInvalid: "LANGGRAPH_RETRIEVER_QUERY_ADAPTER_SCOPE_INVALID",
  queryInvalid: "LANGGRAPH_RETRIEVER_QUERY_INVALID",
});

// Messages name the rule, never the query or any document text.
const retrieverError = (code, message) => {
  const error = new TypeError(message);

  error.code = code;
  return error;
};

// An empty list is refused rather than passed on: Qdrant reads `[]` as "no
// filter" (the retrieval tier answers it with a 400 for that reason), so a
// retriever built without documents could search every tenant's chunks.
const toDocIds = (docIds) => {
  if (
    !Array.isArray(docIds) ||
    docIds.length === 0 ||
    docIds.some((docId) => typeof docId !== "string" || docId.trim() === "")
  ) {
    throw retrieverError(
      LANGGRAPH_RETRIEVER_ERROR_CODES.docIdsInvalid,
      "ArchiveRagRetriever needs a non-empty array of document ids from the runtime."
    );
  }

  return Object.freeze([...docIds]);
};

const toMode = (mode) => {
  if (!Object.values(ARCHIVE_RAG_RETRIEVER_MODES).includes(mode)) {
    throw retrieverError(
      LANGGRAPH_RETRIEVER_ERROR_CODES.modeInvalid,
      'ArchiveRagRetriever `mode` must be "global" or "per_document".'
    );
  }

  return mode;
};

// The per-document seam has no query adapter (comparison is unmeasured with
// it, query-adapter.js), so a scope there would be silently ignored.
const toQueryAdapterScope = (queryAdapterScope, mode) => {
  if (queryAdapterScope !== null && mode !== ARCHIVE_RAG_RETRIEVER_MODES.global) {
    throw retrieverError(
      LANGGRAPH_RETRIEVER_ERROR_CODES.queryAdapterScopeInvalid,
      "ArchiveRagRetriever `queryAdapterScope` applies to the global mode only."
    );
  }

  return queryAdapterScope;
};

const isPlainRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// The text leaves the stored copy as an `undefined` placeholder rather than
// being deleted, so toRetrievalResults writes it back into the same key
// position: a restored result serializes byte for byte like the seam's (trace
// events and the claim-check memo's content keys serialize results).
const toDocument = (result, resultDocId) => {
  const chunk = isPlainRecord(result?.document) ? result.document : null;
  const textMoved = typeof chunk?.pageContent === "string";
  const record = {
    result: textMoved ? { ...result, document: { ...chunk, pageContent: undefined } } : result,
    textMoved,
    ...(resultDocId === undefined ? {} : { resultDocId }),
  };

  return new Document({
    id: typeof chunk?.id === "string" ? chunk.id : undefined,
    pageContent: textMoved ? chunk.pageContent : "",
    // The record goes last: a chunk metadata key of the same name only loses
    // its top-level view, while the record keeps the whole original metadata.
    metadata: {
      ...(isPlainRecord(chunk?.metadata) ? chunk.metadata : {}),
      [RETRIEVAL_RESULT_METADATA_KEY]: record,
    },
  });
};

const readRecord = (document) => {
  const record = document?.metadata?.[RETRIEVAL_RESULT_METADATA_KEY];

  if (!isPlainRecord(record) || !Object.hasOwn(record, "result") || typeof record.textMoved !== "boolean") {
    throw retrieverError(
      LANGGRAPH_RETRIEVER_ERROR_CODES.documentInvalid,
      "The document did not come from ArchiveRagRetriever."
    );
  }

  return record;
};

const fromDocument = (document) => {
  const record = readRecord(document);

  if (!record.textMoved) {
    return record.result;
  }

  return {
    ...record.result,
    document: { ...record.result.document, pageContent: document.pageContent },
  };
};

/** LangChain Documents for the results the global seam returned, in order. */
export const toRetrieverDocuments = (results = []) =>
  (Array.isArray(results) ? results : []).map((result) => toDocument(result));

/**
 * LangChain Documents for the per-document seam's `resultsByDocument`,
 * flattened in its (docIds) order; each remembers the entry it came from.
 */
export const toPerDocumentRetrieverDocuments = (resultsByDocument = new Map()) =>
  [...resultsByDocument.entries()].flatMap(([resultDocId, results]) =>
    (Array.isArray(results) ? results : []).map((result) => toDocument(result, resultDocId))
  );

/** The seam's result objects back from ArchiveRagRetriever documents, in order. */
export const toRetrievalResults = (documents = []) =>
  (Array.isArray(documents) ? documents : []).map(fromDocument);

/**
 * The per-document seam's `resultsByDocument` back from a per_document
 * retriever's documents: one entry per docId in `docIds` order, empty for a
 * document that returned nothing, as the seam builds it.
 */
export const toPerDocumentRetrievalResults = (documents = [], docIds = []) => {
  const resultsByDocument = new Map(docIds.map((docId) => [docId, []]));

  for (const document of Array.isArray(documents) ? documents : []) {
    const { resultDocId } = readRecord(document);

    if (!resultsByDocument.has(resultDocId)) {
      throw retrieverError(
        LANGGRAPH_RETRIEVER_ERROR_CODES.documentInvalid,
        "The document belongs to no requested document id."
      );
    }

    resultsByDocument.get(resultDocId).push(fromDocument(document));
  }

  return resultsByDocument;
};

export class ArchiveRagRetriever extends BaseRetriever {
  // Serializable needs a namespace; serialization itself stays off
  // (lc_serializable false), and nothing runtime-owned is handed to the base
  // constructor, so toJSON() -- which LangChain passes to any callback handler
  // -- carries neither the scope nor the document ids.
  lc_namespace = ["archive_rag", "langgraph", "retrievers"];

  #accessScope;
  #docIds;
  #mode;
  #queryAdapterScope;
  #retrievalOptions;

  constructor({
    accessScope = null,
    docIds,
    mode = ARCHIVE_RAG_RETRIEVER_MODES.global,
    queryAdapterScope = null,
    retrievalOptions = {},
  } = {}) {
    // Before super(): nothing of LangChain is constructed while LangSmith
    // tracing is switched on.
    assertLangSmithTracingDisabled();

    const safeMode = toMode(mode);
    const safeDocIds = toDocIds(docIds);
    const safeQueryAdapterScope = toQueryAdapterScope(queryAdapterScope, safeMode);

    super({});
    this.#accessScope = accessScope;
    this.#docIds = safeDocIds;
    this.#mode = safeMode;
    this.#queryAdapterScope = safeQueryAdapterScope;
    this.#retrievalOptions = Object.freeze({ ...(retrievalOptions ?? {}) });
    // stream, batch and the runnables pipe / withConfig / ... build check
    // LangSmith before LangChain configures their callbacks.
    guardRunnableEntryPoints(this);
  }

  get mode() {
    return this.#mode;
  }

  get docIds() {
    return this.#docIds;
  }

  // invoke is LangChain's entry (batch and stream call it): it configures
  // callbacks, reads tracing settings and calls handleRetrieverStart before
  // _getRelevantDocuments runs, so the guard goes in front of all of that.
  async invoke(input, options) {
    assertLangSmithTracingDisabled();

    return super.invoke(input, options);
  }

  async _getRelevantDocuments(query) {
    assertLangSmithTracingDisabled();

    if (typeof query !== "string") {
      throw retrieverError(LANGGRAPH_RETRIEVER_ERROR_CODES.queryInvalid, "ArchiveRagRetriever takes a query string.");
    }

    const args = {
      accessScope: this.#accessScope,
      // A fresh copy per call: nothing downstream can change the runtime's list.
      docIds: [...this.#docIds],
      primaryQueryText: null,
      primaryQueryVector: null,
      retrievalOptions: this.#retrievalOptions,
      retrievalQueries: buildRetrievalQueries({ query, requirements: [] }),
    };

    if (this.#mode === ARCHIVE_RAG_RETRIEVER_MODES.perDocument) {
      const { resultsByDocument } = await retrievePerDocumentContextForQueries(args);

      return toPerDocumentRetrieverDocuments(resultsByDocument);
    }

    const { results } = await retrieveGlobalContextForQueries({
      ...args,
      queryAdapterScope: this.#queryAdapterScope,
    });

    return toRetrieverDocuments(results);
  }
}
