import {
  createRequestCancellation,
  getRequestBudgetMs,
  getRequestDeadline,
  runWithRequestCancellation,
  runWithRequestDeadline,
} from "../request-deadline.js";

// The deadline of the request this process is serving, for the calls it makes
// to other tiers on that request's behalf (service-client.js). A tier that
// received a signed call with SERVICE_DEADLINE_HEADER (requireServiceIdentity
// fixes req.serviceIdentity.deadlineAt at arrival) runs the rest of the
// request inside runWithServiceCallDeadline or bindServiceCallDeadline, and an
// outbound call then spends at most the time left: the remote retrieval
// client (remote-retrieval.js) and the model gateway client pass
// getServiceCallBudgetMs() as their timeoutMs, and a call made after the
// deadline fails at once with a timeout instead of doing work nobody waits
// for. The bound deadline also aborts in-flight model calls when it passes
// (request-deadline.js holds the one store all of this reads). Without a
// bound deadline nothing changes: calls use their configured timeout.

/**
 * Runs `callback` with `deadlineAt` (epoch ms, or null for none) as the call
 * deadline; its timer is cleared once `callback` settles.
 */
export const runWithServiceCallDeadline = (deadlineAt, callback) =>
  runWithRequestDeadline({ deadlineAt }, callback);

/**
 * Express middleware: the rest of the request runs with the caller's deadline
 * (req.serviceIdentity.deadlineAt) as the call deadline, until the response
 * closes. Mount after requireServiceIdentity; a request without a deadline
 * runs without one.
 */
export const bindServiceCallDeadline = (req, res, next) => {
  const cancellation = createRequestCancellation({
    deadlineAt: req?.serviceIdentity?.deadlineAt ?? null,
  });

  res?.once?.("close", () => cancellation.dispose());

  return runWithRequestCancellation(cancellation, next);
};

/** The bound deadline (epoch ms), or null. */
export const getServiceCallDeadline = () => getRequestDeadline();

/**
 * The budget for one outbound call: `timeoutMs` capped by what is left of the
 * bound deadline. 0 once the deadline has passed; `timeoutMs` without one.
 */
export const getServiceCallBudgetMs = (timeoutMs, options) => getRequestBudgetMs(timeoutMs, options);
