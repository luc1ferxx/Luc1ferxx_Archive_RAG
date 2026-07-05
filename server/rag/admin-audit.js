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

export const createAdminAuditService = ({
  createEventId = randomUUID,
  maxEvents = DEFAULT_MAX_EVENTS,
  now = () => new Date().toISOString(),
} = {}) => {
  const boundedMaxEvents = Math.max(1, Math.floor(Number(maxEvents)) || DEFAULT_MAX_EVENTS);
  let events = [];

  const recordEvent = (event = {}) => {
    const compactEvent = compactAdminAuditEvent({
      createdAt: now(),
      eventId: createEventId(),
      ...event,
    });

    events = [...events, compactEvent].slice(-boundedMaxEvents);

    return compactEvent;
  };

  return {
    listEvents({ limit } = {}) {
      const boundedLimit = normalizeLimit({
        limit,
        maxEvents: boundedMaxEvents,
      });

      return {
        events: events.slice(-boundedLimit).reverse(),
        limit: boundedLimit,
        status: "ok",
        total: events.length,
      };
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
