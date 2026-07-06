import { randomUUID } from "crypto";
import {
  normalizeAccessPrincipalPermissions,
  normalizeAccessPrincipalRoles,
  normalizeScopeText,
} from "../access-scope.js";

export const ADMIN_AUDIT_EVENT_TYPES = Object.freeze({
  authorizationDecision: "admin.authorization.decision",
});

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

export const compactAdminAuditEvent = (event = {}) => {
  const eventRecord = normalizeRecord(event);
  const authorization = normalizeRecord(eventRecord.authorization);
  const allowed = authorization.allowed === true;

  return {
    authorization: {
      actionId: normalizeScopeText(authorization.actionId),
      allowed,
      permissionId: normalizeScopeText(authorization.permissionId),
      reason: normalizeScopeText(authorization.reason),
      roleId: normalizeScopeText(authorization.roleId),
    },
    createdAt: normalizeScopeText(eventRecord.createdAt),
    eventId: normalizeScopeText(eventRecord.eventId),
    principal: normalizePrincipal(
      eventRecord.principal ?? eventRecord.accessScope
    ),
    request: normalizeRequestContext(eventRecord.request),
    result: allowed ? ADMIN_AUDIT_RESULTS.allowed : ADMIN_AUDIT_RESULTS.denied,
    type:
      normalizeScopeText(eventRecord.type) ||
      ADMIN_AUDIT_EVENT_TYPES.authorizationDecision,
  };
};

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
  let sequenceId = 0;

  return {
    async initialize() {
      return true;
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
