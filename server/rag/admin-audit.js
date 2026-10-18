import { randomUUID } from "crypto";
import {
  normalizeAccessPrincipalPermissions,
  normalizeAccessPrincipalRoles,
  normalizeScopeText,
} from "../access-scope.js";
import {
  computeAdminAuditRowHash,
  getAdminAuditChainOwner,
} from "./admin-audit-chain.js";
import { tenantSelectorMatches } from "./tenant-records.js";

export const ADMIN_AUDIT_EVENT_TYPES = Object.freeze({
  authorizationDecision: "admin.authorization.decision",
  dataAccess: "data.access",
  // The tombstone of a tenant erase and the record of a tenant export
  // (rag/tenant-lifecycle.js): who ran it, and in `details` the tenant's ids
  // and per-table counts, never a record's content.
  tenantErased: "admin.tenant.erased",
  tenantExported: "admin.tenant.exported",
});

// Data-plane audit events (ADMIN_AUDIT_DATA_EVENTS, rag/data-access-audit.js):
// one stable id per audited route. Each names the resource type it acts on,
// the permission its route requires (the RBAC route table's for the data
// routes, the admin permission for the platform reads; written as text so
// this module does not load the permission catalogs) and whether the route is
// destructive: a destructive route records its intent before the effect and
// does not run when that record cannot be written (503 AUDIT_UNAVAILABLE).
export const DATA_ACCESS_ACTION_IDS = Object.freeze({
  adminAuditCrossTenantRead: "admin.audit.cross_tenant_read",
  adminStatusCrossTenantRead: "admin.status.cross_tenant_read",
  documentDelete: "document.delete",
  documentFileDownload: "document.file.download",
  documentReplace: "document.replace",
  documentsClear: "documents.clear",
  memoryClear: "memory.clear",
  memoryDelete: "memory.delete",
  sessionDelete: "session.delete",
  // POST /admin/tenants/erase (routes/admin-tenant-lifecycle.js): a platform
  // admin's erase of a whole tenant. Its target is the erased tenant's ids;
  // the erase's own tombstone (admin.tenant.erased) is written as well.
  tenantErase: "tenant.erase",
});

const defineDataAccessAction = (id, { destructive = false, permissionId, resourceType }) =>
  Object.freeze({ destructive, id, permissionId, resourceType });

export const DATA_ACCESS_ACTIONS = Object.freeze({
  [DATA_ACCESS_ACTION_IDS.adminAuditCrossTenantRead]: defineDataAccessAction(
    DATA_ACCESS_ACTION_IDS.adminAuditCrossTenantRead,
    { permissionId: "admin.audit.read", resourceType: "admin_audit" }
  ),
  [DATA_ACCESS_ACTION_IDS.adminStatusCrossTenantRead]: defineDataAccessAction(
    DATA_ACCESS_ACTION_IDS.adminStatusCrossTenantRead,
    { permissionId: "admin.status.read", resourceType: "admin_status" }
  ),
  [DATA_ACCESS_ACTION_IDS.documentDelete]: defineDataAccessAction(
    DATA_ACCESS_ACTION_IDS.documentDelete,
    { destructive: true, permissionId: "documents.delete", resourceType: "document" }
  ),
  [DATA_ACCESS_ACTION_IDS.documentFileDownload]: defineDataAccessAction(
    DATA_ACCESS_ACTION_IDS.documentFileDownload,
    { permissionId: "documents.read", resourceType: "document" }
  ),
  [DATA_ACCESS_ACTION_IDS.documentReplace]: defineDataAccessAction(
    DATA_ACCESS_ACTION_IDS.documentReplace,
    { permissionId: "documents.write", resourceType: "document" }
  ),
  [DATA_ACCESS_ACTION_IDS.documentsClear]: defineDataAccessAction(
    DATA_ACCESS_ACTION_IDS.documentsClear,
    { destructive: true, permissionId: "documents.delete", resourceType: "document" }
  ),
  [DATA_ACCESS_ACTION_IDS.memoryClear]: defineDataAccessAction(
    DATA_ACCESS_ACTION_IDS.memoryClear,
    { permissionId: "memory.write", resourceType: "long_memory" }
  ),
  [DATA_ACCESS_ACTION_IDS.memoryDelete]: defineDataAccessAction(
    DATA_ACCESS_ACTION_IDS.memoryDelete,
    { permissionId: "memory.write", resourceType: "long_memory" }
  ),
  [DATA_ACCESS_ACTION_IDS.sessionDelete]: defineDataAccessAction(
    DATA_ACCESS_ACTION_IDS.sessionDelete,
    { permissionId: "memory.write", resourceType: "session_memory" }
  ),
  [DATA_ACCESS_ACTION_IDS.tenantErase]: defineDataAccessAction(
    DATA_ACCESS_ACTION_IDS.tenantErase,
    { destructive: true, permissionId: "admin.tenants.erase", resourceType: "tenant" }
  ),
});

export const getDataAccessAction = (actionId) =>
  Object.hasOwn(DATA_ACCESS_ACTIONS, String(actionId ?? ""))
    ? DATA_ACCESS_ACTIONS[actionId]
    : null;

export const DATA_ACCESS_OUTCOMES = Object.freeze({
  failed: "failed",
  notFound: "not_found",
  refused: "refused",
  requested: "requested",
  succeeded: "succeeded",
});

const DATA_ACCESS_OUTCOME_VALUES = new Set(Object.values(DATA_ACCESS_OUTCOMES));

/** The outcome of a route that answered `status`. */
export const describeDataAccessOutcome = (status) => {
  const code = Number(status);

  if (!Number.isInteger(code) || code >= 500) {
    return DATA_ACCESS_OUTCOMES.failed;
  }

  if (code === 404) {
    return DATA_ACCESS_OUTCOMES.notFound;
  }

  return code >= 400 ? DATA_ACCESS_OUTCOMES.refused : DATA_ACCESS_OUTCOMES.succeeded;
};

// Ids and counts only: a data event never carries a question, a file name, a
// memory's text or any other content, and its ids are bounded.
const MAX_DATA_ACCESS_RESOURCE_IDS = 100;
const MAX_DATA_ACCESS_ID_LENGTH = 256;

export const ADMIN_AUDIT_RESULTS = Object.freeze({
  allowed: "allowed",
  denied: "denied",
});

const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_LIMIT = 50;
const DEFAULT_OFFSET = 0;

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const normalizeLimit = ({ limit, maxEvents }) => {
  const numericLimit = Math.floor(Number(limit));

  if (!Number.isFinite(numericLimit) || numericLimit <= 0) {
    return Math.min(DEFAULT_LIMIT, maxEvents);
  }

  return Math.min(numericLimit, maxEvents);
};

const normalizeOffset = (offset) => {
  const numericOffset = Math.floor(Number(offset));

  return Number.isFinite(numericOffset) && numericOffset > 0
    ? numericOffset
    : DEFAULT_OFFSET;
};

const normalizeDateFilter = (value) => {
  const text = normalizeScopeText(value);

  if (!text) {
    return "";
  }

  const date = new Date(text);

  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

const normalizeResultFilter = (value) => {
  const result = normalizeScopeText(value).toLowerCase();

  return Object.values(ADMIN_AUDIT_RESULTS).includes(result) ? result : "";
};

const normalizeRequestContext = (request = {}) => {
  const requestRecord = normalizeRecord(request);

  return {
    method: normalizeScopeText(requestRecord.method).toUpperCase(),
    path: normalizeScopeText(requestRecord.path),
    route: normalizeScopeText(requestRecord.route),
  };
};

const normalizePrincipal = (principal = {}) => {
  const principalRecord = normalizeRecord(principal);

  return {
    authenticated: principalRecord.authenticated === true,
    permissionIds: normalizeAccessPrincipalPermissions(principalRecord),
    roleIds: normalizeAccessPrincipalRoles(principalRecord),
    userId: normalizeScopeText(
      principalRecord.userId ?? principalRecord.user_id
    ),
    workspaceId: normalizeScopeText(
      principalRecord.workspaceId ?? principalRecord.workspace_id
    ),
  };
};

const compactDataAccessId = (value) =>
  normalizeScopeText(value).slice(0, MAX_DATA_ACCESS_ID_LENGTH);

const toDataAccessCount = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const count = Number(value);

  return Number.isSafeInteger(count) && count >= 0 ? count : null;
};

const toDataAccessStatus = (value) => {
  const status = toDataAccessCount(value);

  return status !== null && status >= 100 && status <= 599 ? status : null;
};

export const compactDataAccess = (value = {}) => {
  const record = normalizeRecord(value);
  const target = normalizeRecord(record.target);
  const resourceIds = (Array.isArray(record.resourceIds) ? record.resourceIds : [])
    .map(compactDataAccessId)
    .filter(Boolean);
  const outcome = normalizeScopeText(record.outcome).toLowerCase();

  return {
    actionId: compactDataAccessId(record.actionId),
    count: toDataAccessCount(record.count),
    outcome: DATA_ACCESS_OUTCOME_VALUES.has(outcome) ? outcome : "",
    resourceIds: resourceIds.slice(0, MAX_DATA_ACCESS_RESOURCE_IDS),
    // Kept when an already compacted block is compacted again (the stores
    // compact what the service compacted, and every read compacts the row).
    resourceIdsTruncated:
      record.resourceIdsTruncated === true || resourceIds.length > MAX_DATA_ACCESS_RESOURCE_IDS,
    resourceType: compactDataAccessId(record.resourceType),
    status: toDataAccessStatus(record.status),
    target: {
      userId: compactDataAccessId(target.userId),
      workspaceId: compactDataAccessId(target.workspaceId),
    },
  };
};

const AUDIT_DETAIL_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const AUDIT_DETAIL_WORD_PATTERN = /^[a-z0-9_]{1,64}$/;
const MAX_AUDIT_DETAIL_ENTRIES = 64;
const AUDIT_DETAIL_KEY_ID_PATTERN = /^tk_[0-9a-f]{40}$/;

const normalizeDetailId = (value) =>
  value === null || value === undefined ? null : normalizeScopeText(value).slice(0, 256);

/**
 * The `details` of a tenant lifecycle event: ids, counts and fixed words only,
 * so no record content can reach the audit log through it. Null when nothing
 * is left; the compact event then carries no `details` key at all, so every
 * other event keeps its exact shape.
 */
export const normalizeAdminAuditDetails = (details) => {
  const record = normalizeRecord(details, null);

  if (!record) {
    return null;
  }

  const normalized = {};
  const tenant = normalizeRecord(record.tenant, null);

  if (tenant) {
    normalized.tenant = {
      userId: normalizeDetailId(tenant.userId),
      workspaceId: normalizeDetailId(tenant.workspaceId) ?? "",
    };
  }

  const counts = normalizeRecord(record.counts, null);

  if (counts) {
    normalized.counts = Object.fromEntries(
      Object.entries(counts)
        .filter(
          ([key, value]) =>
            AUDIT_DETAIL_KEY_PATTERN.test(key) && Number.isSafeInteger(value) && value >= 0
        )
        .slice(0, MAX_AUDIT_DETAIL_ENTRIES)
    );
  }

  if (typeof record.outcome === "string" && AUDIT_DETAIL_WORD_PATTERN.test(record.outcome)) {
    normalized.outcome = record.outcome;
  }

  for (const flag of ["dryRun", "force"]) {
    if (typeof record[flag] === "boolean") {
      normalized[flag] = record[flag];
    }
  }

  if (Array.isArray(record.skippedStores)) {
    normalized.skippedStores = record.skippedStores
      .filter((store) => typeof store === "string" && AUDIT_DETAIL_WORD_PATTERN.test(store))
      .slice(0, MAX_AUDIT_DETAIL_ENTRIES);
  }

  // The crypto-shred of an erase (TENANT_ENCRYPTION, rag/tenant-encryption.js):
  // key ids (hashes of the scope) and version numbers only, never material.
  const tenantKeys = normalizeRecord(record.tenantKeys, null);

  if (tenantKeys) {
    const keyEntries = (entries) =>
      (Array.isArray(entries) ? entries : [])
        .map((entry) => normalizeRecord(entry, null))
        .filter((entry) => entry && AUDIT_DETAIL_KEY_ID_PATTERN.test(String(entry.keyId ?? "")))
        .slice(0, MAX_AUDIT_DETAIL_ENTRIES);

    normalized.tenantKeys = {
      destroyed: keyEntries(tenantKeys.destroyed).map((entry) => ({
        keyId: entry.keyId,
        versions: (Array.isArray(entry.versions) ? entry.versions : [])
          .filter((version) => Number.isSafeInteger(version) && version > 0)
          .slice(0, MAX_AUDIT_DETAIL_ENTRIES),
      })),
      kept: keyEntries(tenantKeys.kept).map((entry) => ({ keyId: entry.keyId })),
      status:
        typeof tenantKeys.status === "string" && AUDIT_DETAIL_WORD_PATTERN.test(tenantKeys.status)
          ? tenantKeys.status
          : "",
    };
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
};

export const compactAdminAuditEvent = (event = {}) => {
  const eventRecord = normalizeRecord(event);
  const authorization = normalizeRecord(eventRecord.authorization);
  const allowed = authorization.allowed === true;
  const details = normalizeAdminAuditDetails(eventRecord.details);
  const type =
    normalizeScopeText(eventRecord.type) ||
    ADMIN_AUDIT_EVENT_TYPES.authorizationDecision;

  return {
    authorization: {
      actionId: normalizeScopeText(authorization.actionId),
      allowed,
      permissionId: normalizeScopeText(authorization.permissionId),
      reason: normalizeScopeText(authorization.reason),
      roleId: normalizeScopeText(authorization.roleId),
    },
    createdAt: normalizeScopeText(eventRecord.createdAt),
    ...(details ? { details } : {}),
    eventId: normalizeScopeText(eventRecord.eventId),
    principal: normalizePrincipal(
      eventRecord.principal ?? eventRecord.accessScope
    ),
    request: normalizeRequestContext(eventRecord.request),
    result: allowed ? ADMIN_AUDIT_RESULTS.allowed : ADMIN_AUDIT_RESULTS.denied,
    type,
    // Only data events carry the block, so an authorization event keeps the
    // shape it always had.
    ...(type === ADMIN_AUDIT_EVENT_TYPES.dataAccess
      ? { dataAccess: compactDataAccess(eventRecord.dataAccess) }
      : {}),
  };
};

/**
 * A compacted event as the table's columns (migration 008 plus 041's
 * data_access), written under `owner`'s ids. Both stores hash this object
 * (rag/admin-audit-chain.js) and the PostgreSQL store inserts it, so what is
 * hashed is exactly what is stored.
 */
export const toAdminAuditStoredRow = (event = {}, owner = {}) => ({
  action_id: event.authorization?.actionId ?? "",
  authorization_decision: normalizeRecord(event.authorization),
  created_at: event.createdAt ?? "",
  data_access: normalizeRecord(event.dataAccess),
  // Only a tenant lifecycle event carries details (migration 038); the key is
  // left out otherwise, so every other row hashes exactly as before.
  ...(event.details ? { details: normalizeRecord(event.details) } : {}),
  event_id: event.eventId ?? "",
  event_type: event.type ?? "",
  method: event.request?.method ?? "",
  path: event.request?.path ?? "",
  permission_id: event.authorization?.permissionId ?? "",
  principal: normalizeRecord(event.principal),
  request: normalizeRecord(event.request),
  result: event.result ?? "",
  route: event.request?.route ?? "",
  user_id: String(owner.userId ?? ""),
  workspace_id: String(owner.workspaceId ?? ""),
});

export const normalizeAdminAuditQuery = (
  {
    accessScope = {},
    action = "",
    actionId = "",
    createdAfter = "",
    createdBefore = "",
    filters = {},
    from = "",
    limit,
    offset,
    permissionId = "",
    result = "",
    to = "",
    userId = "",
    workspaceId = "",
  } = {},
  { maxEvents = DEFAULT_MAX_EVENTS } = {}
) => {
  const filterRecord = normalizeRecord(filters);
  const accessScopeRecord = normalizeRecord(accessScope);
  const scopeWorkspaceId = normalizeScopeText(accessScopeRecord.workspaceId);
  const requestedWorkspaceId = normalizeScopeText(
    filterRecord.workspaceId ?? workspaceId
  );

  return {
    actionId: normalizeScopeText(filterRecord.actionId ?? actionId ?? action),
    from: normalizeDateFilter(filterRecord.from ?? createdAfter ?? from),
    limit: normalizeLimit({
      limit: filterRecord.limit ?? limit,
      maxEvents,
    }),
    offset: normalizeOffset(filterRecord.offset ?? offset),
    permissionId: normalizeScopeText(filterRecord.permissionId ?? permissionId),
    result: normalizeResultFilter(filterRecord.result ?? result),
    scopeMismatch: Boolean(
      scopeWorkspaceId &&
        requestedWorkspaceId &&
        scopeWorkspaceId !== requestedWorkspaceId
    ),
    to: normalizeDateFilter(filterRecord.to ?? createdBefore ?? to),
    userId: normalizeScopeText(filterRecord.userId ?? userId),
    workspaceId: scopeWorkspaceId || requestedWorkspaceId,
  };
};

const getEventCreatedAtTime = (event = {}) => {
  const date = new Date(event.createdAt);

  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
};

const compareNewestFirst = (left, right) => {
  const rightSequence = Number(right._sequenceId ?? right._rowId ?? 0);
  const leftSequence = Number(left._sequenceId ?? left._rowId ?? 0);

  if (rightSequence !== leftSequence) {
    return rightSequence - leftSequence;
  }

  return getEventCreatedAtTime(right) - getEventCreatedAtTime(left);
};

export const toPublicAdminAuditEvent = (event = {}) => {
  const { _rowId, _sequenceId, ...publicEvent } = event;

  return publicEvent;
};

export const eventMatchesAdminAuditQuery = (event = {}, query = {}) => {
  if (query.scopeMismatch) {
    return false;
  }

  if (query.workspaceId && event.principal?.workspaceId !== query.workspaceId) {
    return false;
  }

  if (query.userId && event.principal?.userId !== query.userId) {
    return false;
  }

  if (query.actionId && event.authorization?.actionId !== query.actionId) {
    return false;
  }

  if (
    query.permissionId &&
    event.authorization?.permissionId !== query.permissionId
  ) {
    return false;
  }

  if (query.result && event.result !== query.result) {
    return false;
  }

  const createdAtTime = getEventCreatedAtTime(event);

  if (query.from && createdAtTime < getEventCreatedAtTime({ createdAt: query.from })) {
    return false;
  }

  if (query.to && createdAtTime > getEventCreatedAtTime({ createdAt: query.to })) {
    return false;
  }

  return true;
};

export const buildAdminAuditListResponse = ({
  events = [],
  query = {},
  total = 0,
} = {}) => {
  const nextOffset =
    query.offset + events.length < total ? query.offset + events.length : null;

  return {
    events: events.map(toPublicAdminAuditEvent),
    limit: query.limit,
    nextOffset,
    offset: query.offset,
    status: "ok",
    total,
  };
};

export const createInMemoryAdminAuditStore = ({
  maxEvents = DEFAULT_MAX_EVENTS,
} = {}) => {
  const boundedMaxEvents = Math.max(
    1,
    Math.floor(Number(maxEvents)) || DEFAULT_MAX_EVENTS
  );
  let events = [];
  let chainRows = [];
  let sequenceId = 0;
  // Each chain's head hash (rag/admin-audit-chain.js), kept apart from the
  // bounded event list: an evicted event shortens its chain's start, as the
  // PostgreSQL retention purge does, and never forks the chain. Unlike the
  // PostgreSQL store it keeps every event's own time: eviction goes by count,
  // not by time, so a time older than the chain head removes nothing out of
  // order.
  const chainHeads = new Map();

  return {
    async initialize() {
      return true;
    },

    // The tenant export (rag/tenant-records.js): the events whose principal
    // is the tenant's. A tenant erase keeps them, so there is no delete call.
    async listTenantRecords(selector) {
      return events
        .filter((event) => tenantSelectorMatches(selector, event.principal))
        .map((event) => ({
          record: structuredClone(toPublicAdminAuditEvent(event)),
          table: "admin_audit_events",
        }));
    },

    /**
     * The stored rows with their hashes, in id order, for verification
     * (createAdminAuditChainVerifier): the shape the PostgreSQL store returns,
     * bounded like the events.
     */
    async listChainRows({ afterId = 0, limit = 1000 } = {}) {
      const boundedLimit = Math.max(1, Math.floor(Number(limit)) || 1000);
      const after = Number(afterId) || 0;

      return chainRows
        .filter((row) => row.id > after)
        .slice(0, boundedLimit)
        .map((row) => ({ ...row }));
    },

    async listEvents(queryOptions = {}) {
      const query = normalizeAdminAuditQuery(queryOptions, {
        maxEvents: boundedMaxEvents,
      });
      const filteredEvents = events
        .filter((event) => eventMatchesAdminAuditQuery(event, query))
        .sort(compareNewestFirst);
      const pageEvents = filteredEvents.slice(
        query.offset,
        query.offset + query.limit
      );

      return buildAdminAuditListResponse({
        events: pageEvents,
        query,
        total: filteredEvents.length,
      });
    },

    async recordEvent(event = {}) {
      const storedEvent = {
        ...compactAdminAuditEvent(event),
        _sequenceId: ++sequenceId,
      };
      // Without a database the owner columns are the principal's own ids.
      const owner = {
        userId: storedEvent.principal.userId,
        workspaceId: storedEvent.principal.workspaceId,
      };
      const chainKey = JSON.stringify(getAdminAuditChainOwner(owner));
      const row = toAdminAuditStoredRow(storedEvent, owner);
      const prevHash = chainHeads.get(chainKey) ?? null;
      const rowHash = computeAdminAuditRowHash(prevHash, row);

      chainHeads.set(chainKey, rowHash);
      chainRows = [
        ...chainRows,
        { ...row, id: storedEvent._sequenceId, prev_hash: prevHash, row_hash: rowHash },
      ].slice(-boundedMaxEvents);
      events = [...events, storedEvent].slice(-boundedMaxEvents);

      return toPublicAdminAuditEvent(storedEvent);
    },
  };
};

export const createAdminAuditService = ({
  createEventId = randomUUID,
  maxEvents = DEFAULT_MAX_EVENTS,
  now = () => new Date().toISOString(),
  store = createInMemoryAdminAuditStore({ maxEvents }),
} = {}) => {
  const recordEvent = (event = {}) =>
    store.recordEvent(
      compactAdminAuditEvent({
        createdAt: now(),
        eventId: createEventId(),
        ...event,
      })
    );

  return {
    async initialize() {
      return store.initialize?.();
    },

    listEvents(queryOptions = {}) {
      return store.listEvents(queryOptions);
    },

    // The tenant export's listing of the audit log, when the store has one.
    ...(typeof store.listTenantRecords === "function"
      ? { listTenantRecords: (selector) => store.listTenantRecords(selector) }
      : {}),
    ...(typeof store.iterateTenantRecords === "function"
      ? { iterateTenantRecords: (selector) => store.iterateTenantRecords(selector) }
      : {}),

    /**
     * A tenant lifecycle event (rag/tenant-lifecycle.js): the erase tombstone
     * or the export record. `accessScope` is the principal who ran it;
     * `details` names the tenant and the counts (normalizeAdminAuditDetails).
     */
    recordTenantLifecycleEvent({
      accessScope = {},
      actionId = "",
      details = {},
      permissionId = "",
      reason = "",
      request = {},
      type = ADMIN_AUDIT_EVENT_TYPES.tenantErased,
    } = {}) {
      return recordEvent({
        authorization: {
          actionId,
          allowed: true,
          permissionId,
          reason,
          roleId: "",
        },
        details,
        principal: accessScope,
        request,
        type,
      });
    },

    /** Stored rows with their chain hashes (audit:verify); null if the store keeps none. */
    async listChainRows(options = {}) {
      return typeof store.listChainRows === "function" ? store.listChainRows(options) : null;
    },

    /**
     * One data-plane event (ids and counts only) under the request's own
     * principal. `actionId` must be one of DATA_ACCESS_ACTION_IDS.
     */
    async recordDataAccess({
      accessScope = {},
      actionId = "",
      count = null,
      outcome = "",
      request = {},
      resourceIds = [],
      status = null,
      target = {},
    } = {}) {
      const action = getDataAccessAction(actionId);

      if (!action) {
        throw new TypeError(`Unknown data access audit action "${String(actionId)}".`);
      }

      return recordEvent({
        authorization: {
          actionId: action.id,
          allowed: true,
          permissionId: action.permissionId,
          reason: "",
          roleId: "",
        },
        dataAccess: {
          actionId: action.id,
          count,
          outcome,
          resourceIds,
          resourceType: action.resourceType,
          status,
          target,
        },
        principal: accessScope,
        request,
        type: ADMIN_AUDIT_EVENT_TYPES.dataAccess,
      });
    },

    recordAuthorizationDecision({
      accessScope = {},
      actionId = "",
      decision = {},
      request = {},
    } = {}) {
      return recordEvent({
        authorization: {
          actionId,
          allowed: decision.allowed === true,
          permissionId: decision.permissionId,
          reason: decision.reason,
          roleId: decision.roleId,
        },
        principal: accessScope,
        request,
        type: ADMIN_AUDIT_EVENT_TYPES.authorizationDecision,
      });
    },
  };
};
