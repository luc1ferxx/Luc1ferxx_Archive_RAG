import { getDocumentsPostgresTable, getTenantMaxDocumentBytes, getTenantMaxDocuments } from "./config.js";
import { getDocumentStorageTotalsFunctionName } from "./db-migrations.js";
import {
  findDocumentByContentHash,
  isDocumentRegistryShared,
  listStoredDocumentSizes,
} from "./doc-registry.js";
import { isPostgresConfigured, queryPostgres as queryDefaultPostgres } from "./postgres.js";
import { recordTenantRefusal } from "./tenant-refusals.js";

// Storage quotas (TENANT_MAX_DOCUMENTS, TENANT_MAX_DOCUMENT_BYTES; 0 = no
// limit, the default). A quota scope is a workspace (every user's documents in
// it) when the document names one, else the user's own documents without a
// workspace. A document that names neither (auth disabled without a user) has
// no quota scope and is never refused.
//
// The authoritative check runs in rag/index.js commitDocument:
//   - pgvector: inside the commit transaction, after the index write lock and
//     the content-hash lock and before the replacement's documents-row lock,
//     under a transaction-scoped advisory lock on the quota scope, so commits
//     into one scope queue behind each other and the count each one reads
//     (migration 037's storage_totals function, as the table owner because a
//     workspace's documents belong to several users) includes every earlier
//     commit;
//   - local / Qdrant: under an in-process lock on the scope; the count comes
//     from the shared PostgreSQL registry when there is one, else from this
//     process's registry map. Uploads racing in several processes against a
//     non-transactional provider may overshoot by the number racing.
// The upload routes check early too (assertTenantStorageQuotaAllows), so an
// upload over quota is refused before it is parsed, embedded or queued.
//
// Refusals carry the stable code TENANT_STORAGE_QUOTA_EXCEEDED, `limit`
// ("documents" or "document_bytes"), `expose: true` and `retryable: false` (an
// async ingest job fails at once instead of retrying): 429 for the document
// count, 413 for the stored bytes.

export const TENANT_STORAGE_QUOTA_EXCEEDED = "TENANT_STORAGE_QUOTA_EXCEEDED";

export const TENANT_STORAGE_QUOTA_LIMITS = Object.freeze({
  documentBytes: "document_bytes",
  documents: "documents",
});

const normalizeId = (value) => String(value ?? "").trim();

const toCount = (value) => {
  const count = Number(value);

  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
};

export const getTenantStorageQuotaLimits = () => ({
  maxDocumentBytes: getTenantMaxDocumentBytes(),
  maxDocuments: getTenantMaxDocuments(),
});

export const hasTenantStorageQuota = (limits = getTenantStorageQuotaLimits()) =>
  toCount(limits?.maxDocuments) > 0 || toCount(limits?.maxDocumentBytes) > 0;

/** The quota scope of a document's owner pair, or null when it names neither. */
export const resolveStorageQuotaScope = ({ ownerUserId = "", workspaceId = "" } = {}) => {
  const workspace = normalizeId(workspaceId);
  const user = normalizeId(ownerUserId);

  if (workspace) {
    return { kind: "workspace", userId: "", workspaceId: workspace };
  }

  return user ? { kind: "user", userId: user, workspaceId: "" } : null;
};

export const describeStorageQuotaScopeKey = (scope) =>
  JSON.stringify(["archive_rag:storage_quota", scope.kind, scope.workspaceId, scope.userId]);

export const createTenantStorageQuotaError = (limit) => {
  const byBytes = limit === TENANT_STORAGE_QUOTA_LIMITS.documentBytes;

  return Object.assign(
    new Error(
      byBytes
        ? "This upload would take the workspace over its document storage quota. Delete documents to make room."
        : "The workspace already holds as many documents as its quota allows. Delete documents to make room."
    ),
    {
      code: TENANT_STORAGE_QUOTA_EXCEEDED,
      expose: true,
      limit,
      retryable: false,
      status: byBytes ? 413 : 429,
    }
  );
};

export const isTenantStorageQuotaError = (error) => error?.code === TENANT_STORAGE_QUOTA_EXCEEDED;

/** The body fields a route adds for a quota refusal (none for any other error). */
export const describeTenantStorageQuotaError = (error) =>
  isTenantStorageQuotaError(error) ? { code: error.code, limit: error.limit } : {};

/**
 * Which limit `addedDocuments` / `addedBytes` on top of `totals` would break,
 * or null. Only growth is refused: a replacement that shrinks a document, or a
 * scope already over a lowered quota that adds nothing, passes.
 */
export const evaluateTenantStorageQuota = ({
  addedBytes = 0,
  addedDocuments = 0,
  limits = getTenantStorageQuotaLimits(),
  totals = {},
} = {}) => {
  const maxDocuments = toCount(limits?.maxDocuments);
  const maxDocumentBytes = toCount(limits?.maxDocumentBytes);
  const documents = toCount(addedDocuments);
  const bytes = Number(addedBytes) > 0 ? Math.floor(Number(addedBytes)) : 0;

  if (maxDocuments > 0 && documents > 0 && toCount(totals.documentCount) + documents > maxDocuments) {
    return TENANT_STORAGE_QUOTA_LIMITS.documents;
  }

  if (maxDocumentBytes > 0 && bytes > 0 && toCount(totals.documentBytes) + bytes > maxDocumentBytes) {
    return TENANT_STORAGE_QUOTA_LIMITS.documentBytes;
  }

  return null;
};

const readTotalsFromRegistryMap = (scope) => {
  let documentCount = 0;
  let documentBytes = 0;

  for (const document of listStoredDocumentSizes()) {
    const owner = normalizeId(document?.ownerUserId);
    const workspace = normalizeId(document?.workspaceId);
    const inScope =
      scope.kind === "workspace"
        ? workspace === scope.workspaceId
        : workspace === "" && owner === scope.userId;

    if (inScope) {
      documentCount += 1;
      documentBytes += toCount(document?.fileSize);
    }
  }

  return { documentBytes, documentCount };
};

/**
 * The documents and stored bytes of a quota scope. On `client` (the commit
 * transaction) or, without one, on the pool when the registry is the shared
 * PostgreSQL table; otherwise from this process's registry map, which is the
 * whole registry there (one writer).
 */
export const readTenantStorageTotals = async (
  scope,
  {
    client = null,
    documentsTable = getDocumentsPostgresTable(),
    query = queryDefaultPostgres,
    registryShared = isDocumentRegistryShared,
  } = {}
) => {
  if (client || (registryShared() && isPostgresConfigured())) {
    const run = client ? (text, values) => client.query(text, values) : query;
    const result = await run(
      `SELECT document_count, document_bytes FROM ${getDocumentStorageTotalsFunctionName(documentsTable)}($1, $2)`,
      [scope.workspaceId, scope.userId]
    );
    const row = result?.rows?.[0] ?? {};

    return { documentBytes: toCount(row.document_bytes), documentCount: toCount(row.document_count) };
  }

  return readTotalsFromRegistryMap(scope);
};

/**
 * Inside the commit transaction: serializes commits into one quota scope until
 * COMMIT (a transaction-scoped advisory lock). Taken after the index write
 * lock and the content-hash lock and before any documents-row lock.
 */
export const lockTenantStorageQuota = async (
  scope,
  { client, documentsTable = getDocumentsPostgresTable() }
) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    JSON.stringify(["archive_rag:storage_quota", documentsTable, scope.kind, scope.workspaceId, scope.userId]),
  ]);
};

/**
 * Throws the quota error when the owner pair's scope cannot take
 * `addedDocuments` more documents and `addedBytes` more bytes. Does nothing
 * (and reads nothing) when no quota is configured or the pair has no scope.
 * `lock` takes the scope's advisory lock first (commit transaction only).
 */
export const assertTenantStorageQuota = async ({
  addedBytes = 0,
  addedDocuments = 0,
  client = null,
  limits = getTenantStorageQuotaLimits(),
  lock = false,
  ownerUserId = "",
  readTotals = readTenantStorageTotals,
  workspaceId = "",
} = {}) => {
  if (!hasTenantStorageQuota(limits)) {
    return null;
  }

  const scope = resolveStorageQuotaScope({ ownerUserId, workspaceId });

  if (!scope) {
    return null;
  }

  if (lock && client) {
    await lockTenantStorageQuota(scope, { client });
  }

  const totals = await readTotals(scope, { client });
  const exceeded = evaluateTenantStorageQuota({ addedBytes, addedDocuments, limits, totals });

  if (exceeded) {
    // Counted for the owner pair (rag/tenant-refusals.js), once per check
    // that refuses: a request the early check refuses never reaches the
    // commit's.
    recordTenantRefusal(TENANT_STORAGE_QUOTA_EXCEEDED, { userId: ownerUserId, workspaceId });
    throw createTenantStorageQuotaError(exceeded);
  }

  return totals;
};

/**
 * The early check at upload time (POST /upload/init with the declared size,
 * and before an upload is ingested or queued). Same rule, no lock: the commit
 * checks again. With `duplicateOfSha256` (deduplication on), bytes the owner
 * pair already stored pass: they resolve to the stored document and add
 * nothing.
 */
export const assertTenantStorageQuotaAllows = async ({
  duplicateOfSha256 = null,
  findByContentHash = findDocumentByContentHash,
  limits = getTenantStorageQuotaLimits(),
  ownerUserId = "",
  workspaceId = "",
  ...input
} = {}) => {
  if (!hasTenantStorageQuota(limits) || !resolveStorageQuotaScope({ ownerUserId, workspaceId })) {
    return null;
  }

  if (duplicateOfSha256 && (await findByContentHash(duplicateOfSha256, { ownerUserId, workspaceId }))) {
    return null;
  }

  return assertTenantStorageQuota({
    ...input,
    client: null,
    limits,
    lock: false,
    ownerUserId,
    workspaceId,
  });
};
