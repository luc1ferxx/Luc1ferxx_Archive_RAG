import { getRetrievalServiceTimeoutMs } from "../config.js";
import { getActiveDatabaseTenant } from "../postgres-tenant.js";
import {
  getRequestSignal,
  isRequestCancelledError,
  REQUEST_CANCELLATION_REASONS,
} from "../request-deadline.js";
import { getActiveRunUsage } from "../run-usage.js";
import { getServiceClient, getServiceTimeoutMs, ServiceTimeoutError } from "../service-client.js";
import { isRemoteRetrievalEnabled, SERVICE_TIERS } from "../service-topology.js";
import { SPAN_KINDS, setSpanAttributes, withSpan } from "../tracing.js";
import { getServiceCallBudgetMs } from "./call-deadline.js";
import { decodeWireValue, encodeWireValue } from "./wire.js";

// The calling side of the retrieval tier (retrieval-service.mjs). A process
// whose retrieval runs remotely (service-topology.js isRemoteRetrievalEnabled:
// RETRIEVAL_SERVICE_URL is set and this process is not the retrieval tier)
// sends each retrieval of the document RAG path here instead of reading the
// vector store itself (document-rag-execution.js holds the seam).
//
// A request carries the query texts, the docIds, topK and the query adapter
// scope, never a query vector: the retrieval tier embeds every query itself,
// in the space its index serves (embedding-cache.js), so the vector a search
// ranks by is always one the retrieval tier's own embedding produced and the
// query adapter (query-adapter.js), which only adapts model-marked vectors,
// behaves exactly as in process. Results come back through the lossless wire
// codec (wire.js) with their provenance, route summaries, adapter stamps and
// reranker scores unchanged.
//
// Retrieval is read-only, so every call is idempotent and fails over between
// replicas (service-client.js). A tier that cannot answer rejects with the
// client's ServiceUnavailableError (503: SERVICE_UNREACHABLE,
// SERVICE_UNAVAILABLE, SERVICE_NOT_CONFIGURED) or ServiceTimeoutError (504:
// SERVICE_TIMEOUT); any other non-200 answer rejects with a
// RetrievalServiceError carrying the tier's stable code and the status
// toCallerStatus gives it. None of their messages name a URL, a query or
// document text. The model calls the tier made for an answer are charged to
// this process's active agent run (run-usage.js), as they are in process.
//
// A call made for a request with a deadline (request-deadline.js) spends at
// most what is left of it, sends that as the tier's deadline, and is aborted
// when the request is cancelled: a call the deadline cut is SERVICE_TIMEOUT
// whichever timer fired first, and a client that left aborts it with its own
// reason.

export const RETRIEVAL_SERVICE_AUDIENCE = SERVICE_TIERS.retrieval;

export const RETRIEVAL_SERVICE_PATHS = Object.freeze({
  global: "/internal/retrieval/v1/global",
  perDocument: "/internal/retrieval/v1/per-document",
  // GET, any signed identity for this audience including a system token: a
  // 200 proves the replica is reachable and accepts the caller's key.
  ping: "/internal/retrieval/v1/ping",
  search: "/internal/retrieval/v1/search",
});

export const RETRIEVAL_SERVICE_ERROR_CODES = Object.freeze({
  deadlineExceeded: "RETRIEVAL_DEADLINE_EXCEEDED",
  failed: "RETRIEVAL_FAILED",
  invalidDocIds: "RETRIEVAL_DOC_IDS_INVALID",
  invalidQuery: "RETRIEVAL_QUERY_INVALID",
  invalidQueryAdapterScope: "RETRIEVAL_QUERY_ADAPTER_SCOPE_INVALID",
  invalidRequest: "RETRIEVAL_REQUEST_INVALID",
  invalidResponse: "RETRIEVAL_RESPONSE_INVALID",
  invalidTopK: "RETRIEVAL_TOP_K_INVALID",
  queryTooLong: "RETRIEVAL_QUERY_TOO_LONG",
  requestTooLarge: "RETRIEVAL_REQUEST_TOO_LARGE",
  scopeMismatch: "RETRIEVAL_SCOPE_MISMATCH",
  tooManyDocIds: "RETRIEVAL_TOO_MANY_DOC_IDS",
  tooManyQueries: "RETRIEVAL_TOO_MANY_QUERIES",
});

// The tier's answer when a dependency it needs (the model gateway, an
// embedding or rerank backend) is unavailable; the body names the
// dependency's 502/503/504 as `dependencyStatus`. Not a status the service
// client fails over on, since every replica shares that dependency.
export const RETRIEVAL_DEPENDENCY_UNAVAILABLE_STATUS = 424;

const STABLE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The retrieval tier answered, but not with results: a 4xx for a request it
 * refused (the code says which bound), a dependency it found unavailable, an
 * identity it refused, or a 5xx other than 502/503/504 for a failure of its
 * own. `code` comes from the tier and `status` from toCallerStatus; the
 * message never carries request text.
 */
export class RetrievalServiceError extends Error {
  constructor(message, { code = RETRIEVAL_SERVICE_ERROR_CODES.failed, status = 500 } = {}) {
    super(message);
    this.name = "RetrievalServiceError";
    this.code = code;
    this.service = RETRIEVAL_SERVICE_AUDIENCE;
    this.status = status;
  }

  toResponseBody() {
    return { code: this.code, error: this.message, service: this.service };
  }
}

/** Whether this process sends its retrieval to the retrieval tier. */
export const isRetrievalRemote = (env = process.env) => isRemoteRetrievalEnabled(env);

const normalizeId = (value) => String(value ?? "").trim();

const toSignedScope = (scope) => ({
  authenticated: scope?.authenticated === true,
  userId: normalizeId(scope?.userId),
  workspaceId: normalizeId(scope?.workspaceId),
});

/**
 * The tenant a remote retrieval acts for: the caller's access scope when it
 * names a user or workspace, otherwise the database tenant this async chain
 * is bound to (a request under bindDatabaseTenant, a task under
 * runWithDatabaseTenant), otherwise the empty scope an auth-disabled request
 * carries, which the retrieval tier runs as no tenant -- exactly what the
 * in-process search would see. A scope and a bound tenant that disagree are
 * refused: one retrieval never acts for two tenants. Only the ids are signed;
 * the retrieval tier needs no permissions.
 */
export const resolveRetrievalAccessScope = (accessScope = null) => {
  const tenant = getActiveDatabaseTenant();
  const scope = accessScope && typeof accessScope === "object" ? toSignedScope(accessScope) : null;

  if (scope && (scope.userId || scope.workspaceId)) {
    if (tenant && (tenant.userId !== scope.userId || tenant.workspaceId !== scope.workspaceId)) {
      throw new RetrievalServiceError(
        "The retrieval scope does not match the database tenant this request acts for.",
        { code: RETRIEVAL_SERVICE_ERROR_CODES.scopeMismatch, status: 500 }
      );
    }

    return scope;
  }

  if (tenant) {
    return { authenticated: true, userId: tenant.userId, workspaceId: tenant.workspaceId };
  }

  return scope ?? toSignedScope({});
};

const getCallTimeoutMs = () => getRetrievalServiceTimeoutMs() || getServiceTimeoutMs();

const toQueryPayload = (retrievalQueries = []) =>
  (Array.isArray(retrievalQueries) ? retrievalQueries : []).map((retrievalQuery) => ({
    // tagResultsWithQuery reads these two exactly like this.
    id: String(retrievalQuery?.id ?? "query"),
    primary: Boolean(retrievalQuery?.primary),
    query: retrievalQuery?.query,
  }));

const toOptionalTopK = (value) => (value === undefined || value === null ? null : value);

const readErrorCode = (json) => {
  const code = typeof json?.code === "string" ? json.code : "";

  return STABLE_CODE_PATTERN.test(code) ? code : RETRIEVAL_SERVICE_ERROR_CODES.failed;
};

const describeStatus = (status) =>
  status === 400 || status === 413
    ? "The retrieval service refused the request"
    : status === 401 || status === 403
      ? "The retrieval service refused this service's identity"
      : status === RETRIEVAL_DEPENDENCY_UNAVAILABLE_STATUS
        ? "A dependency of the retrieval service is unavailable"
        : "The retrieval service failed";

// The status the caller of chat() sees. An unavailable dependency keeps its
// own 502/503/504, as the same failure has in process. The tier refusing this
// process's identity or not knowing the endpoint (401/403/404) is a fault of
// this deployment, not of the end user's request, so it is a 500 like any
// internal failure rather than a public 401/403/404. A request bound
// (400/413) and a rate limit (429) keep theirs.
const toCallerStatus = (status, json) => {
  if (status === RETRIEVAL_DEPENDENCY_UNAVAILABLE_STATUS) {
    const dependencyStatus = Number(json?.dependencyStatus);

    return [502, 503, 504].includes(dependencyStatus) ? dependencyStatus : 503;
  }

  if (status === 401 || status === 403 || status === 404) {
    return 500;
  }

  return status >= 400 ? status : 502;
};

const toUsageCount = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

// Adds the tier's usage totals to the active run's meter the way
// run-usage.js chargeRunUsage adds each successful call's (cost rounded to
// the micro-dollar), so run ceilings and agentObservability.budget.run count
// retrieval's model calls in split mode as they do in process.
const chargeRetrievalUsage = (usage) => {
  const runUsage = getActiveRunUsage();

  if (!runUsage?.used || !usage || typeof usage !== "object") {
    return;
  }

  runUsage.used.modelCalls += Math.floor(toUsageCount(usage.modelCalls));
  runUsage.used.tokens += toUsageCount(usage.tokens);
  runUsage.used.unpricedModelCalls += Math.floor(toUsageCount(usage.unpricedModelCalls));
  runUsage.used.costUsd =
    Math.round((runUsage.used.costUsd + toUsageCount(usage.costUsd)) * 1_000_000) / 1_000_000;
};

const callRetrievalService = async ({ accessScope, body, operation, path, spanAttributes }) =>
  withSpan(
    `retrieval.remote ${operation}`,
    { "retrieval.operation": operation, ...spanAttributes },
    async (span) => {
      const client = getServiceClient(SERVICE_TIERS.retrieval);
      const scope = resolveRetrievalAccessScope(accessScope);
      const timeoutMs = getServiceCallBudgetMs(getCallTimeoutMs());

      if (timeoutMs <= 0) {
        throw new ServiceTimeoutError("The retrieval service call had no time left before its deadline.", {
          attempts: 0,
          service: RETRIEVAL_SERVICE_AUDIENCE,
        });
      }

      let response;

      try {
        response = await client.request({
          accessScope: scope,
          body: encodeWireValue(body),
          idempotent: true,
          method: "POST",
          path,
          signal: getRequestSignal() ?? undefined,
          timeoutMs,
        });
      } catch (error) {
        // The bound request's deadline and the call's budget (capped by that
        // deadline) end together; whichever timer fired, a call cut by the
        // deadline fails like one that ran out of budget. A client that left
        // is the caller's own abort and passes through.
        if (
          isRequestCancelledError(error) &&
          error.reason === REQUEST_CANCELLATION_REASONS.deadlineExceeded
        ) {
          throw new ServiceTimeoutError("The retrieval service call ran out of time before its deadline.", {
            attempts: 1,
            service: RETRIEVAL_SERVICE_AUDIENCE,
          });
        }

        throw error;
      }

      setSpanAttributes(span, { "http.response.status_code": response.status });

      if (response.status !== 200) {
        const code = readErrorCode(response.json);

        throw new RetrievalServiceError(`${describeStatus(response.status)} (${code}).`, {
          code,
          status: toCallerStatus(response.status, response.json),
        });
      }

      if (!response.json || typeof response.json !== "object") {
        throw new RetrievalServiceError("The retrieval service answered without a JSON body.", {
          code: RETRIEVAL_SERVICE_ERROR_CODES.invalidResponse,
          status: 502,
        });
      }

      let payload;

      try {
        payload = decodeWireValue(response.json);
      } catch {
        throw new RetrievalServiceError("The retrieval service answered with a malformed body.", {
          code: RETRIEVAL_SERVICE_ERROR_CODES.invalidResponse,
          status: 502,
        });
      }

      chargeRetrievalUsage(payload?.usage);
      return payload;
    },
    { kind: SPAN_KINDS.client }
  );

const requireArray = (value, name) => {
  if (!Array.isArray(value)) {
    throw new RetrievalServiceError(`The retrieval service answered without ${name}.`, {
      code: RETRIEVAL_SERVICE_ERROR_CODES.invalidResponse,
      status: 502,
    });
  }

  return value;
};

/**
 * retrieveGlobalContextForQueries on the retrieval tier: every retrieval
 * query searched over `docIds`, merged and cut to the unified Top-K.
 * Resolves { results, retrieval }.
 */
export const retrieveGlobalContextRemotely = async ({
  accessScope = null,
  docIds,
  queryAdapterScope = null,
  retrievalOptions = {},
  retrievalQueries,
}) => {
  const queries = toQueryPayload(retrievalQueries);
  const payload = await callRetrievalService({
    accessScope,
    body: {
      docIds,
      queries,
      queryAdapterScope: queryAdapterScope ?? null,
      topK: toOptionalTopK(retrievalOptions?.topK),
    },
    operation: "global",
    path: RETRIEVAL_SERVICE_PATHS.global,
    spanAttributes: { "retrieval.document_count": docIds?.length ?? 0, "retrieval.query_count": queries.length },
  });

  return { results: requireArray(payload?.results, "results"), retrieval: payload?.retrieval };
};

/**
 * retrievePerDocumentContextForQueries on the retrieval tier. Resolves
 * { resultsByDocument (Map docId -> results, one entry per requested docId),
 * retrieval }.
 */
export const retrievePerDocumentContextRemotely = async ({
  accessScope = null,
  docIds,
  retrievalOptions = {},
  retrievalQueries,
}) => {
  const queries = toQueryPayload(retrievalQueries);
  const payload = await callRetrievalService({
    accessScope,
    body: {
      docIds,
      queries,
      topKPerDoc: toOptionalTopK(retrievalOptions?.topKPerDoc),
    },
    operation: "per_document",
    path: RETRIEVAL_SERVICE_PATHS.perDocument,
    spanAttributes: { "retrieval.document_count": docIds?.length ?? 0, "retrieval.query_count": queries.length },
  });

  if (!(payload?.resultsByDocument instanceof Map)) {
    throw new RetrievalServiceError("The retrieval service answered without resultsByDocument.", {
      code: RETRIEVAL_SERVICE_ERROR_CODES.invalidResponse,
      status: 502,
    });
  }

  return { resultsByDocument: payload.resultsByDocument, retrieval: payload.retrieval };
};

/**
 * retrieveGlobalContextWithRoutes for one query on the retrieval tier (the
 * QA gap plan's supplemental searches). Resolves { fusion, results, routes }.
 */
export const searchGlobalContextRemotely = async ({ accessScope = null, docIds, queryText, topK = null }) => {
  const payload = await callRetrievalService({
    accessScope,
    body: { docIds, query: queryText, topK: toOptionalTopK(topK) },
    operation: "search",
    path: RETRIEVAL_SERVICE_PATHS.search,
    spanAttributes: { "retrieval.document_count": docIds?.length ?? 0, "retrieval.query_count": 1 },
  });

  return { fusion: payload?.fusion, results: requireArray(payload?.results, "results"), routes: payload?.routes };
};
