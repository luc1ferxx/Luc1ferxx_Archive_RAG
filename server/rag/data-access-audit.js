import { isAdminAuditDataEventsEnabled } from "./config.js";
import {
  DATA_ACCESS_OUTCOMES,
  describeDataAccessOutcome,
} from "./admin-audit.js";

// Data-plane audit events from the routes (ADMIN_AUDIT_DATA_EVENTS, default
// off): which tenant downloaded, deleted, cleared or replaced which document,
// cleared which memory or session, when a platform admin read across tenants,
// and which tenant a platform admin erased (POST /admin/tenants/erase, an
// applied erase only; the erase's own tombstone is written regardless). They
// go through the admin audit service (rag/admin-audit.js, type
// `data.access`) under the request's own tenant binding, so migration 032's
// INSERT policy accepts them and they extend that tenant's chain (migration
// 041). Ids and counts only: never a question, a file name or memory text.
//
// A destructive route (DATA_ACCESS_ACTIONS[...].destructive) records its
// intent before the effect and answers 503 AUDIT_UNAVAILABLE without running
// when that record cannot be written; its outcome record, and every other
// route's single record after the effect, never fails the request.

export const AUDIT_UNAVAILABLE_CODE = "AUDIT_UNAVAILABLE";
export const AUDIT_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The answer of an action refused because its audit record could not be written. */
export const sendAuditUnavailable = (res) => {
  if (typeof res.set === "function") {
    res.set("Retry-After", String(AUDIT_UNAVAILABLE_RETRY_AFTER_SECONDS));
  }

  return res.status(503).json({
    code: AUDIT_UNAVAILABLE_CODE,
    error: "The audit record for this action could not be written, so the action was not performed.",
    retryAfterSeconds: AUDIT_UNAVAILABLE_RETRY_AFTER_SECONDS,
    retryable: true,
  });
};

/**
 * A principal that reads across tenants on the admin routes: its scope names
 * no workspace and it has no workspace list (routes/admin.js reads the audit
 * trail on the owner path for it).
 */
export const isPlatformAdminReadScope = (accessScope = {}) =>
  !String(accessScope?.workspaceId ?? "").trim() &&
  !(accessScope?.allowedWorkspaceIds?.length > 0);

const getRequestAuditContext = (req = {}) => ({
  method: req.method,
  path: req.path,
  route: req.route?.path,
});

// Only the action and the error's code: a driver message can quote values.
const warnUnrecorded = (actionId, error) => {
  console.warn(
    `Could not write the data access audit event "${actionId}"${error?.code ? ` (${error.code})` : ""}.`
  );
};

export const createDataAccessAudit = ({
  auditService = null,
  isEnabled = isAdminAuditDataEventsEnabled,
} = {}) => {
  const canRecord = () =>
    isEnabled() === true && typeof auditService?.recordDataAccess === "function";

  return {
    isEnabled: canRecord,

    /**
     * Before a destructive effect. Resolves true when the route may go on;
     * false when the intent could not be recorded, after answering 503.
     */
    async recordIntent(req, res, { accessScope = {}, actionId, resourceIds = [], target = {} } = {}) {
      if (!canRecord()) {
        return true;
      }

      // An unknown action id is refused by recordDataAccess, which lands in
      // the catch below: the route then fails closed like any unwritten record.
      try {
        await auditService.recordDataAccess({
          accessScope,
          actionId,
          outcome: DATA_ACCESS_OUTCOMES.requested,
          request: getRequestAuditContext(req),
          resourceIds,
          target,
        });
        return true;
      } catch (error) {
        warnUnrecorded(actionId, error);
        sendAuditUnavailable(res);
        return false;
      }
    },

    /** After the effect (or the refusal) with the status the route answers. */
    async recordOutcome(req, { accessScope = {}, actionId, count = null, resourceIds = [], status, target = {} } = {}) {
      if (!canRecord()) {
        return;
      }

      try {
        await auditService.recordDataAccess({
          accessScope,
          actionId,
          count,
          outcome: describeDataAccessOutcome(status),
          request: getRequestAuditContext(req),
          resourceIds,
          status,
          target,
        });
      } catch (error) {
        warnUnrecorded(actionId, error);
      }
    },
  };
};
