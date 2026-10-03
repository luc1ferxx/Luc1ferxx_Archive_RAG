import { randomUUID } from "node:crypto";

import { SpanKind } from "@opentelemetry/api";
import express from "express";

import { bindDatabaseTenant } from "../../auth.js";
import { derivePgvectorHealthProblems } from "../../health.js";
import {
  getHybridFusionMethod,
  getRetrievalRoute,
  getRetrievalServiceMaxDocIds,
  getRetrievalServiceMaxQueries,
  getRetrievalServiceMaxQueryChars,
  getRetrievalServiceMaxTopK,
  getVectorStoreProviderConfigStatus,
  isHybridRetrievalEnabled,
} from "../config.js";
import { runPostgresMigrations } from "../db-migrations.js";
import {
  getStoredDocument,
  initializeDocumentRegistry,
  isDocumentRegistryShared,
  loadDocumentsFromStore,
} from "../doc-registry.js";
import {
  retrieveGlobalContextForQueriesInProcess,
  retrievePerDocumentContextForQueriesInProcess,
  searchGlobalContextInProcess,
} from "../document-rag-execution.js";
import { isPostgresConfigured } from "../postgres.js";
import { isReadReplicaRoutingEnabled } from "../postgres-replicas.js";
import { runAsDatabaseSystem } from "../postgres-tenant.js";
import { describeQueryAdapterHealth, QUERY_ADAPTER_SCOPE_QA } from "../query-adapter.js";
import { createRunUsage, runWithRunUsage } from "../run-usage.js";
import { bindServiceTraceContext } from "../service-client.js";
import {
  handleServiceRequestBodyError,
  requireServiceIdentity,
  SERVICE_CALL_POLICY,
  verifyServiceRequestBody,
} from "../service-identity.js";
import { describeServiceTopology } from "../service-topology.js";
import { setSpanAttributes, withSpan } from "../tracing.js";
import { describeVectorStoreRuntime, supportsDenseScoreVector } from "../vector-store.js";
import { describePgvectorStatus } from "../vector-store-pgvector.js";
import { runWithServiceCallDeadline } from "./call-deadline.js";
import {
  RETRIEVAL_DEPENDENCY_UNAVAILABLE_STATUS,
  RETRIEVAL_SERVICE_AUDIENCE,
  RETRIEVAL_SERVICE_ERROR_CODES,
  RETRIEVAL_SERVICE_PATHS,
} from "./remote-retrieval.js";
import { decodeWireValue, encodeWireValue } from "./wire.js";

// The retrieval tier (ARCHIVE_RAG_ROLE=retrieval, retrieval-service.mjs).
//
// Three internal endpoints run the document RAG path's retrieval
// (document-rag-execution.js *InProcess functions: query embedding, dense and
// sparse routes, fusion, rerank, the multi-query merge) for a caller whose
// retrieval runs remotely (remote-retrieval.js):
//   POST /internal/retrieval/v1/global        many queries over a document set
//   POST /internal/retrieval/v1/per-document  many queries, per document
//   POST /internal/retrieval/v1/search        one query (gap-plan searches)
// Bodies and answers go through the lossless wire codec (wire.js), so results
// keep their provenance, route summaries, query adapter stamps and reranker
// scores exactly. Each answer also carries `usage`, what its model calls cost,
// which the caller charges to its agent run (run-usage.js).
//
// Only a signed internal identity for this audience from an allowed issuer
// gets through (service-identity.js requireServiceIdentity; system tokens are
// refused: retrieval always acts for a tenant, or for the empty scope of an
// auth-disabled deployment). The token's scope becomes the database tenant
// (bindDatabaseTenant), so PostgreSQL row-level security decides which chunks
// a search can see. On top of that every requested docId the registry does not
// show to that scope is replaced by an id no chunk carries before the search:
// another tenant's document then answers exactly like a document that does
// not exist -- no results, the same route summary -- on every vector store,
// including those without row-level security. The per-document answer is keyed
// by the requested docIds again.
//
// Requests are bounded (RETRIEVAL_SERVICE_MAX_* in config.js; 400 with a
// stable code past a bound, 413 past the body limit). A caller's deadline
// (SERVICE_DEADLINE_HEADER) is honoured: a request that arrives after it is
// refused, and one still running at it is answered 504 (its work is dropped).
// Errors never carry request text: the answer is a status, a stable code and
// a generic message; the log line names the operation, code and status only.
// An unavailable dependency is 424 with its status as `dependencyStatus`
// (toErrorAnswer), so callers do not fail over on an outage every replica
// shares.
// GET /health and GET /ready report the vector store, the index versions and
// the query adapter, with no identity required; GET /internal/retrieval/v1/ping
// answers any signed identity SERVICE_CALL_POLICY lets probe this tier, system
// tokens included.

// The callers SERVICE_CALL_POLICY admits: the agent tier and a monolith.
export const DEFAULT_RETRIEVAL_SERVICE_ISSUERS = SERVICE_CALL_POLICY.retrieval.callers;
export const RETRIEVAL_SERVICE_BODY_LIMIT = "4mb";

const MAX_DOC_ID_LENGTH = 512;
const MAX_QUERY_ID_LENGTH = 512;
// A docId no document can have: the prefix is not a docId format, and the
// random part makes each masked id distinct.
const INVISIBLE_DOCUMENT_PREFIX = "retrieval-invisible-document:";
const STABLE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

class RetrievalRequestError extends Error {
  constructor(message, { code, status = 400 }) {
    super(message);
    this.name = "RetrievalRequestError";
    this.code = code;
    this.status = status;
  }
}

const refuse = (code, message) => new RetrievalRequestError(message, { code });

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Map);

// At least one docId: a store may read an empty list as "no filter" (the
// Qdrant filter does), which would search every tenant's chunks past the mask.
const parseDocIds = (value) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw refuse(RETRIEVAL_SERVICE_ERROR_CODES.invalidDocIds, "docIds must be a non-empty array of document ids.");
  }

  const maxDocIds = getRetrievalServiceMaxDocIds();

  if (value.length > maxDocIds) {
    throw refuse(
      RETRIEVAL_SERVICE_ERROR_CODES.tooManyDocIds,
      `docIds holds ${value.length} entries; at most ${maxDocIds} are allowed.`
    );
  }

  if (value.some((docId) => typeof docId !== "string" || !docId || docId.length > MAX_DOC_ID_LENGTH)) {
    throw refuse(
      RETRIEVAL_SERVICE_ERROR_CODES.invalidDocIds,
      `Every docId must be a non-empty string of at most ${MAX_DOC_ID_LENGTH} characters.`
    );
  }

  return value;
};

const parseQueryText = (value) => {
  if (typeof value !== "string") {
    throw refuse(RETRIEVAL_SERVICE_ERROR_CODES.invalidQuery, "Every query must be a string.");
  }

  const maxChars = getRetrievalServiceMaxQueryChars();

  if (value.length > maxChars) {
    throw refuse(
      RETRIEVAL_SERVICE_ERROR_CODES.queryTooLong,
      `A query holds ${value.length} characters; at most ${maxChars} are allowed.`
    );
  }

  return value;
};

const parseQueries = (value) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw refuse(RETRIEVAL_SERVICE_ERROR_CODES.invalidQuery, "queries must be a non-empty array.");
  }

  const maxQueries = getRetrievalServiceMaxQueries();

  if (value.length > maxQueries) {
    throw refuse(
      RETRIEVAL_SERVICE_ERROR_CODES.tooManyQueries,
      `queries holds ${value.length} entries; at most ${maxQueries} are allowed.`
    );
  }

  return value.map((entry) => {
    if (
      !isPlainObject(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length > MAX_QUERY_ID_LENGTH ||
      typeof entry.primary !== "boolean"
    ) {
      throw refuse(
        RETRIEVAL_SERVICE_ERROR_CODES.invalidQuery,
        "Every query must be { id: string, primary: boolean, query: string }."
      );
    }

    return { id: entry.id, primary: entry.primary, query: parseQueryText(entry.query) };
  });
};

// Absent (null or undefined) keeps the retrieval tier's configured depth.
const parseTopK = (value, name) => {
  if (value === null || value === undefined) {
    return null;
  }

  const maxTopK = getRetrievalServiceMaxTopK();

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maxTopK) {
    throw refuse(
      RETRIEVAL_SERVICE_ERROR_CODES.invalidTopK,
      `${name} must be a positive number of at most ${maxTopK}, or absent.`
    );
  }

  return value;
};

const parseQueryAdapterScope = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  if (value !== QUERY_ADAPTER_SCOPE_QA) {
    throw refuse(
      RETRIEVAL_SERVICE_ERROR_CODES.invalidQueryAdapterScope,
      `queryAdapterScope must be ${JSON.stringify(QUERY_ADAPTER_SCOPE_QA)} or absent.`
    );
  }

  return value;
};

const decodeRequestBody = (body) => {
  let decoded;

  try {
    decoded = decodeWireValue(body);
  } catch {
    throw refuse(RETRIEVAL_SERVICE_ERROR_CODES.invalidRequest, "The request body is not a valid retrieval request.");
  }

  if (!isPlainObject(decoded)) {
    throw refuse(RETRIEVAL_SERVICE_ERROR_CODES.invalidRequest, "The request body must be a JSON object.");
  }

  return decoded;
};

/**
 * `docIds` with every id the registry does not show to `accessScope` replaced
 * by an id no chunk can carry, and the map back. A document another process
 * registered is read by id first when the registry is shared.
 */
export const maskInvisibleDocIds = async (docIds, accessScope = {}) => {
  await initializeDocumentRegistry();

  const isVisible = (docId) => Boolean(getStoredDocument(docId, accessScope));
  // With read replicas a search's freshness guard expects each document at
  // the version this registry holds (rag/vector-store-pgvector.js), so every
  // id is re-read from the primary, not only the unknown ones.
  const reread = isReadReplicaRoutingEnabled() ? docIds : docIds.filter((docId) => !isVisible(docId));

  if (reread.length > 0 && isDocumentRegistryShared()) {
    await loadDocumentsFromStore(reread);
  }

  const originalByMasked = new Map();
  const masked = docIds.map((docId) => {
    if (isVisible(docId)) {
      return docId;
    }

    const maskedId = `${INVISIBLE_DOCUMENT_PREFIX}${randomUUID()}`;

    originalByMasked.set(maskedId, docId);
    return maskedId;
  });

  return {
    docIds: masked,
    invisibleCount: originalByMasked.size,
    unmask: (docId) => originalByMasked.get(docId) ?? docId,
  };
};

const OPERATIONS = {
  global: {
    name: "global",
    parse: (body) => ({
      docIds: parseDocIds(body.docIds),
      queries: parseQueries(body.queries),
      queryAdapterScope: parseQueryAdapterScope(body.queryAdapterScope),
      topK: parseTopK(body.topK, "topK"),
    }),
    run: async (request, accessScope) => {
      const mask = await maskInvisibleDocIds(request.docIds, accessScope);
      const result = await retrieveGlobalContextForQueriesInProcess({
        docIds: mask.docIds,
        primaryQueryText: null,
        primaryQueryVector: null,
        queryAdapterScope: request.queryAdapterScope,
        retrievalOptions: request.topK === null ? {} : { topK: request.topK },
        retrievalQueries: request.queries,
      });

      return { mask, result, resultCount: result.results.length };
    },
  },
  perDocument: {
    name: "per_document",
    parse: (body) => ({
      docIds: parseDocIds(body.docIds),
      queries: parseQueries(body.queries),
      topKPerDoc: parseTopK(body.topKPerDoc, "topKPerDoc"),
    }),
    run: async (request, accessScope) => {
      const mask = await maskInvisibleDocIds(request.docIds, accessScope);
      const search = await retrievePerDocumentContextForQueriesInProcess({
        docIds: mask.docIds,
        primaryQueryText: null,
        primaryQueryVector: null,
        retrievalOptions: request.topKPerDoc === null ? {} : { topKPerDoc: request.topKPerDoc },
        retrievalQueries: request.queries,
      });
      const resultsByDocument = new Map(
        [...search.resultsByDocument.entries()].map(([docId, results]) => [mask.unmask(docId), results])
      );

      return {
        mask,
        result: { ...search, resultsByDocument },
        resultCount: [...resultsByDocument.values()].reduce((total, results) => total + results.length, 0),
      };
    },
  },
  search: {
    name: "search",
    parse: (body) => ({
      docIds: parseDocIds(body.docIds),
      query: parseQueryText(body.query),
      topK: parseTopK(body.topK, "topK"),
    }),
    run: async (request, accessScope) => {
      const mask = await maskInvisibleDocIds(request.docIds, accessScope);
      const result = await searchGlobalContextInProcess({
        docIds: mask.docIds,
        queryText: request.query,
        topK: request.topK,
      });

      return { mask, result, resultCount: result.results.length };
    },
  },
};

const createDeadlineError = () =>
  new RetrievalRequestError("The caller's deadline passed before retrieval finished.", {
    code: RETRIEVAL_SERVICE_ERROR_CODES.deadlineExceeded,
    status: 504,
  });

// Settles with `work` or rejects at `deadlineAt`, whichever comes first. The
// work itself cannot be cancelled; its late result is dropped.
const settleBeforeDeadline = (work, deadlineAt, now) => {
  if (deadlineAt === null) {
    return work;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(createDeadlineError()), Math.max(0, deadlineAt - now()));

    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
};

const GENERIC_MESSAGES = {
  429: "Retrieval is rate limited; retry later.",
  500: "Retrieval failed.",
  [RETRIEVAL_DEPENDENCY_UNAVAILABLE_STATUS]: "A dependency of the retrieval service is unavailable.",
};

// Status and stable code only. A request error keeps its own message (it
// names a bound, never request text); any other error gets a generic message,
// its own HTTP status when it carries one (a dependency's 401/403 as 500, so
// it never reads as this tier refusing the caller's identity), and its code
// only when that status came with it. A dependency's 502/503/504 (the model
// gateway, an embedding or rerank backend) is answered 424 with that status
// as `dependencyStatus`, never with a status the caller's service client
// fails over on: every replica shares the dependency, so failing over would
// repeat the dependency's own retries once per replica and mark each healthy
// replica unhealthy. remote-retrieval.js gives the caller the dependency's
// status back.
const toErrorAnswer = (error) => {
  if (error instanceof RetrievalRequestError) {
    return { body: { code: error.code, error: error.message }, status: error.status };
  }

  const rawStatus = Number(error?.status);
  const hasStatus = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599;
  const dependencyUnavailable = hasStatus && [502, 503, 504].includes(rawStatus);
  const status = !hasStatus
    ? 500
    : dependencyUnavailable
      ? RETRIEVAL_DEPENDENCY_UNAVAILABLE_STATUS
      : [401, 403].includes(rawStatus)
        ? 500
        : rawStatus;
  const code =
    hasStatus && typeof error?.code === "string" && STABLE_CODE_PATTERN.test(error.code)
      ? error.code
      : RETRIEVAL_SERVICE_ERROR_CODES.failed;

  return {
    body: {
      code,
      ...(dependencyUnavailable ? { dependencyStatus: rawStatus } : {}),
      error: GENERIC_MESSAGES[status] ?? (status >= 500 ? GENERIC_MESSAGES[500] : "The retrieval request was refused."),
    },
    status,
  };
};

// What the operation's model calls (query embeddings, a cross-encoder rerank)
// cost. In process they are charged to the agent run through run-usage.js's
// AsyncLocalStorage; that context does not cross HTTP, so the operation runs
// under a meter of its own with no ceilings, and the answer carries its totals
// for remote-retrieval.js to charge to the caller's run.
const runMetered = async (work) => {
  const meter = createRunUsage({ limits: { maxCostUsd: 0, maxDurationMs: 0, maxTokens: 0 } });
  const outcome = await runWithRunUsage(meter, work);
  const { costUsd, modelCalls, tokens, unpricedModelCalls } = meter.used;

  return { ...outcome, usage: { costUsd, modelCalls, tokens, unpricedModelCalls } };
};

const createOperationHandler = (operation, { logger, now }) => async (req, res) => {
  const deadlineAt = req.serviceIdentity?.deadlineAt ?? null;
  const requestId = req.serviceIdentity?.requestId ?? null;

  try {
    if (deadlineAt !== null && deadlineAt <= now()) {
      throw createDeadlineError();
    }

    const request = operation.parse(decodeRequestBody(req.body));
    const outcome = await withSpan(
      `retrieval ${operation.name}`,
      {
        "archive.service.request_id": requestId,
        "retrieval.document_count": request.docIds.length,
        "retrieval.operation": operation.name,
        "retrieval.query_count": request.queries?.length ?? 1,
      },
      async (span) => {
        const settled = await settleBeforeDeadline(
          runWithServiceCallDeadline(deadlineAt, () =>
            runMetered(() => operation.run(request, req.accessScope ?? {}))
          ),
          deadlineAt,
          now
        );

        setSpanAttributes(span, {
          "retrieval.invisible_document_count": settled.mask.invisibleCount,
          "retrieval.result_count": settled.resultCount,
        });
        return settled;
      },
      { kind: SpanKind.SERVER }
    );

    res.status(200).json(encodeWireValue({ ...outcome.result, usage: outcome.usage }));
  } catch (error) {
    const answer = toErrorAnswer(error);

    if (answer.status >= 500 || answer.status === RETRIEVAL_DEPENDENCY_UNAVAILABLE_STATUS) {
      logger.error(
        `[retrieval-service] ${operation.name} failed: ${answer.body.code} (status ${answer.status}, ${error?.name ?? "Error"}).`
      );
    }

    if (!res.headersSent) {
      res.status(answer.status).json(answer.body);
    }
  }
};

// Body parser failures (malformed JSON, a body over the limit) as stable codes.
const handleBodyParserError = (error, req, res, next) => {
  if (!error) {
    next();
    return;
  }

  if (res.headersSent) {
    next(error);
    return;
  }

  const tooLarge = error.type === "entity.too.large" || error.status === 413;

  res.status(tooLarge ? 413 : 400).json({
    code: tooLarge
      ? RETRIEVAL_SERVICE_ERROR_CODES.requestTooLarge
      : RETRIEVAL_SERVICE_ERROR_CODES.invalidRequest,
    error: tooLarge
      ? `The request body exceeds ${RETRIEVAL_SERVICE_BODY_LIMIT}.`
      : "The request body is not valid JSON.",
  });
};

const summarizeIndexVersions = (indexVersions) => {
  if (!indexVersions || indexVersions.registry !== "present") {
    return indexVersions ? { registry: indexVersions.registry } : null;
  }

  return {
    active: indexVersions.active,
    building: indexVersions.building,
    drift: indexVersions.drift,
    generation: indexVersions.generation,
    registry: indexVersions.registry,
    versions: (indexVersions.versions ?? []).map((version) => ({
      chunkCount: version.chunkCount,
      isActive: version.isActive,
      status: version.status,
      versionId: version.versionId,
    })),
    warnings: indexVersions.warnings,
  };
};

const describeVectorStoreHealth = async () => {
  const providerStatus = getVectorStoreProviderConfigStatus();

  if (!providerStatus.valid) {
    return {
      message: `VECTOR_STORE_PROVIDER "${providerStatus.rawValue}" is not allowed; retrieval is disabled.`,
      provider: null,
      status: "error",
    };
  }

  const runtime = describeVectorStoreRuntime();

  if (providerStatus.provider !== "pgvector") {
    return {
      message: `${providerStatus.provider} vector store (not probed by the retrieval service).`,
      provider: providerStatus.provider,
      runtime,
      status: "ok",
    };
  }

  try {
    const status = await runAsDatabaseSystem(async () => {
      if (isPostgresConfigured()) {
        await runPostgresMigrations();
      }

      return describePgvectorStatus();
    });
    const problems = derivePgvectorHealthProblems(status);

    return {
      activeVersion: status.activeVersion ?? null,
      chunkCount: status.chunkCount,
      documentCount: status.documentCount,
      indexVersions: summarizeIndexVersions(status.indexVersions),
      message: problems.length > 0 ? problems.join(" ") : "pgvector index is ready.",
      provider: "pgvector",
      runtime,
      status: problems.length > 0 ? "error" : "ok",
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : "pgvector health check failed.",
      provider: "pgvector",
      runtime,
      status: "error",
    };
  }
};

const describeQueryAdapterStatus = () => {
  try {
    let supportsScoreVector = false;

    try {
      supportsScoreVector = supportsDenseScoreVector();
    } catch {
      // An unknown provider is the vector store entry's error.
    }

    return describeQueryAdapterHealth({
      fusion: getHybridFusionMethod(),
      hybrid: getRetrievalRoute() === "hybrid" && isHybridRetrievalEnabled(),
      supportsScoreVector,
    });
  } catch (error) {
    return { message: error instanceof Error ? error.message : "Query adapter check failed.", status: "error" };
  }
};

const describeTopologyStatus = (env) => {
  const topology = describeServiceTopology(env);

  return {
    errors: topology.errors,
    internalIdentity: topology.internalIdentity,
    role: topology.role,
    status: topology.status === "error" ? "error" : "ok",
    warnings: topology.warnings,
  };
};

/** The retrieval tier's health: vector store, index versions, query adapter, topology. */
export const buildRetrievalHealthReport = async ({ env = process.env } = {}) => {
  const [vectorStore, queryAdapter] = await Promise.all([
    describeVectorStoreHealth(),
    Promise.resolve(describeQueryAdapterStatus()),
  ]);
  const checks = { queryAdapter, serviceTopology: describeTopologyStatus(env), vectorStore };

  return {
    checkedAt: new Date().toISOString(),
    checks,
    service: RETRIEVAL_SERVICE_AUDIENCE,
    status: Object.values(checks).some((entry) => entry.status === "error") ? "error" : "ok",
  };
};

/**
 * The retrieval tier's Express app. `issuers` narrows which roles may call it
 * (default: the monolith `all` with remote retrieval, and `agent`); `env` and
 * `now` are injectable for tests.
 */
export const createRetrievalApp = ({
  env = process.env,
  issuers = DEFAULT_RETRIEVAL_SERVICE_ISSUERS,
  logger = console,
  now = Date.now,
} = {}) => {
  const app = express();

  app.disable("x-powered-by");

  app.get("/health", async (req, res) => {
    const report = await buildRetrievalHealthReport({ env });

    res.json(report);
  });

  app.get("/ready", async (req, res) => {
    const report = await buildRetrievalHealthReport({ env });

    res.status(report.status === "ok" ? 200 : 503).json(report);
  });

  app.get(
    RETRIEVAL_SERVICE_PATHS.ping,
    requireServiceIdentity({ allowSystem: true, audience: RETRIEVAL_SERVICE_AUDIENCE, env, now, purpose: "probe" }),
    (req, res) => {
      res.json({ service: RETRIEVAL_SERVICE_AUDIENCE, status: "ok" });
    }
  );

  const router = express.Router();

  router.use(requireServiceIdentity({ allowSystem: false, audience: RETRIEVAL_SERVICE_AUDIENCE, env, issuers, now }));
  // Parsed before the tenant is bound: body-parser resumes the chain from a
  // stream callback, which would drop an AsyncLocalStorage context bound
  // earlier.
  router.use(express.json({ limit: RETRIEVAL_SERVICE_BODY_LIMIT, verify: verifyServiceRequestBody }));
  router.use(handleServiceRequestBodyError);
  router.use(handleBodyParserError);
  router.use(bindDatabaseTenant);
  router.use(bindServiceTraceContext);
  router.post(RETRIEVAL_SERVICE_PATHS.global, createOperationHandler(OPERATIONS.global, { logger, now }));
  router.post(RETRIEVAL_SERVICE_PATHS.perDocument, createOperationHandler(OPERATIONS.perDocument, { logger, now }));
  router.post(RETRIEVAL_SERVICE_PATHS.search, createOperationHandler(OPERATIONS.search, { logger, now }));

  // Everything but /health and /ready needs the internal identity, unknown
  // paths included.
  app.use(router);
  app.use((req, res) => {
    res.status(404).json({ code: "RETRIEVAL_ROUTE_NOT_FOUND", error: "Unknown retrieval endpoint." });
  });

  return app;
};
