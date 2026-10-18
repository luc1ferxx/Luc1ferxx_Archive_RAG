// Pure helpers for the archive MCP server (server/archive-mcp-server.js).
//
// Everything here is transport-free and provider-free so it can be unit tested
// without OpenAI, a vector store, or PostgreSQL. The MCP wiring file owns the
// side effects; this file owns the shapes.

import {
  getApiAuthTokens,
  isApiAuthEnabled,
  isApiAuthJwtEnabled,
  isApiAuthOidcEnabled,
  isApiAuthWorkspaceRequired,
} from "./rag/config.js";

const EXCERPT_LIMIT = 220;

export const ARCHIVE_MCP_SCOPE_REQUIRED = "ARCHIVE_MCP_SCOPE_REQUIRED";

/**
 * The principal the MCP server acts for. It runs in-process and never passes
 * through API auth, so this is its whole identity: the document registry
 * filter and the database tenant (row-level security) both use it. Null for
 * an unset or blank variable.
 */
export const resolveArchiveMcpAccessScope = (env = process.env) => ({
  userId: String(env.ARCHIVE_MCP_USER_ID ?? "").trim() || null,
  workspaceId: String(env.ARCHIVE_MCP_WORKSPACE_ID ?? "").trim() || null,
});

/**
 * The API auth settings that make this deployment serve more than one tenant:
 * per-principal static tokens (API_AUTH_TOKENS), HS256 JWTs or OIDC tokens,
 * each of which names its own user and workspace, or a required workspace on
 * every request. Empty with API auth off and with the single shared
 * API_AUTH_TOKEN, the single-tenant setups (auth.js treats that token as the
 * whole archive's credential).
 */
export const listMultiTenantAuthSettings = () => {
  if (!isApiAuthEnabled()) {
    return [];
  }

  return [
    getApiAuthTokens().trim() ? "API_AUTH_TOKENS" : "",
    isApiAuthJwtEnabled() ? "API_AUTH_JWT_ENABLED" : "",
    isApiAuthOidcEnabled() ? "API_AUTH_OIDC_ENABLED" : "",
    isApiAuthWorkspaceRequired() ? "API_AUTH_REQUIRE_WORKSPACE" : "",
  ].filter(Boolean);
};

/**
 * Refuses to start the MCP server when it would act for no tenant against a
 * multi-tenant configuration. A scope with neither a user nor a workspace is
 * "every tenant" to the registry filter and runs on the database owner path
 * (no row-level security), so archive_list_documents and archive_ask would
 * read and answer from every tenant's documents. With API auth off or the
 * single shared token, the archive is one tenant and an unscoped server keeps
 * working as before.
 *
 * The rule reads this process's own environment, the same API_AUTH_*
 * variables the API server reads; an MCP server launched without them is
 * treated as a single-tenant setup.
 */
export const assertArchiveMcpScope = (accessScope = resolveArchiveMcpAccessScope()) => {
  if (accessScope?.userId || accessScope?.workspaceId) {
    return;
  }

  const settings = listMultiTenantAuthSettings();

  if (settings.length === 0) {
    return;
  }

  const error = new Error(
    `The archive MCP server acts for no user or workspace, but API auth is configured for several tenants (${settings.join(", ")}); unscoped, it would read every tenant's documents. Set ARCHIVE_MCP_USER_ID and/or ARCHIVE_MCP_WORKSPACE_ID to the tenant it acts for.`
  );
  error.code = ARCHIVE_MCP_SCOPE_REQUIRED;
  error.settings = settings;
  throw error;
};

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const toFiniteNumber = (value) =>
  Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * Projects a `buildCitation` record (server/rag/citations.js) onto the wire.
 * Field names are preserved verbatim so an MCP consumer sees the same citation
 * contract the web workbench renders.
 */
export const formatCitation = (citation = {}) => ({
  rank: toFiniteNumber(citation.rank),
  score: toFiniteNumber(citation.score),
  docId: citation.docId ?? null,
  fileName: citation.fileName ?? "Unknown document",
  filePath: citation.filePath ?? "",
  pageNumber: toFiniteNumber(citation.pageNumber),
  chunkIndex: toFiniteNumber(citation.chunkIndex),
  excerpt: normalizeText(citation.excerpt).slice(0, EXCERPT_LIMIT),
  sectionHeading: citation.sectionHeading ?? null,
});

export const formatCitations = (citations) =>
  toArray(citations).map((citation) => formatCitation(citation));

/**
 * Projects `retrievedContexts` entries (server/rag/answer-writer.js). These
 * carry the full chunk text and are matched to citations by
 * docId + chunkIndex + pageNumber.
 */
export const formatEvidence = (retrievedContexts) =>
  toArray(retrievedContexts).map((context = {}) => ({
    rank: toFiniteNumber(context.rank),
    docId: context.docId ?? null,
    fileName: context.fileName ?? "Unknown document",
    pageNumber: toFiniteNumber(context.pageNumber),
    chunkIndex: toFiniteNumber(context.chunkIndex),
    sectionHeading: context.sectionHeading ?? null,
    text: String(context.text ?? ""),
  }));

/**
 * Shapes a planner-free `chat()` result for MCP.
 *
 * `abstained` and `abstainReason` come first on purpose: when the confidence
 * gate declines to answer, that has to be the first thing the calling model
 * reads. On abstention we deliberately return no citations, so there is nothing
 * for the model to dress up as evidence.
 */
export const formatAskResult = (response = {}) => {
  const abstained = Boolean(response.abstained);
  const abstainReason = abstained
    ? normalizeText(response.abstainReason ?? response.text) || "No reason provided."
    : null;

  return {
    abstained,
    abstainReason,
    answer: abstained ? "" : String(response.text ?? ""),
    citations: abstained ? [] : formatCitations(response.citations),
    evidence: abstained ? [] : formatEvidence(response.retrievedContexts),
    resolvedQuestion: response.resolvedQuery ?? null,
    comparison: response.comparisonAnalysisSummary ?? null,
  };
};

/**
 * Errors are reported in the same shape as an abstention rather than thrown, so
 * a failing archive degrades into "I have no evidence" instead of leaving the
 * calling model to invent an answer.
 */
export const formatToolError = (error) => ({
  abstained: true,
  abstainReason: normalizeText(error?.message) || "The archive request failed.",
  answer: "",
  citations: [],
  evidence: [],
  error: normalizeText(error?.message) || "The archive request failed.",
});

export const formatDocumentList = (documents) =>
  toArray(documents).map((document = {}) => ({
    docId: document.docId ?? null,
    fileName: document.fileName ?? "Unknown document",
    pageCount: toFiniteNumber(document.pageCount),
    chunkCount: toFiniteNumber(document.chunkCount),
    uploadedAt: document.uploadedAt ?? null,
  }));

export const parseDocIdList = (docIds) =>
  toArray(docIds)
    .map((docId) => normalizeText(docId))
    .filter((docId) => docId.length > 0);

/**
 * The planner-free `chat()` entry throws 404 when no docId is supplied
 * (server/rag/index.js:244-248), unlike `POST /chat` which resolves workspace
 * scope through the agent. So an omitted `docIds` has to be widened to "every
 * document in scope" here.
 */
export const resolveDocIds = ({ docIds, availableDocuments } = {}) => {
  const requested = parseDocIdList(docIds);

  if (requested.length > 0) {
    return requested;
  }

  return parseDocIdList(
    toArray(availableDocuments).map((document) => document?.docId)
  );
};

export const buildEmptyArchiveResult = () => ({
  abstained: true,
  abstainReason:
    "The archive has no documents in scope. Upload a PDF in the workbench, then call archive_refresh.",
  answer: "",
  citations: [],
  evidence: [],
});

export const toMcpTextContent = (payload) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(payload, null, 2),
    },
  ],
});

// How long the way out waits for the usage ledger's last write, so a database
// that does not answer cannot hold up the client that closed the server.
export const ARCHIVE_MCP_SHUTDOWN_FLUSH_TIMEOUT_MS = 5000;

/**
 * The server's way out (its client closed stdin, or SIGTERM / SIGINT): what
 * the tool calls booked in the tenant usage ledger (rag/tenant-usage.js: the
 * model tokens and cost of every archive_ask) waits in memory for a flush
 * timer that does not keep the process alive, so `stopLedger` writes it first,
 * then `exit(code)`. Runs once however often it is called; a ledger that fails
 * or takes longer than `timeoutMs` is logged and the server exits anyway.
 */
export const createArchiveMcpShutdown = ({
  exit,
  logger = console,
  stopLedger,
  timeoutMs = ARCHIVE_MCP_SHUTDOWN_FLUSH_TIMEOUT_MS,
} = {}) => {
  let stopping = null;

  return (code = 0) => {
    stopping ??= (async () => {
      let timer = null;

      try {
        await Promise.race([
          Promise.resolve().then(() => stopLedger?.()),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
          }),
        ]);
      } catch (error) {
        logger.error?.(`Failed to flush tenant usage: ${error instanceof Error ? error.message : error}`);
      } finally {
        clearTimeout(timer);
      }

      exit(code);
    })();

    return stopping;
  };
};
