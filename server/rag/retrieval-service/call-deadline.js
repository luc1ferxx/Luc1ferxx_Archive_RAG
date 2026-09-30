import { AsyncLocalStorage } from "node:async_hooks";

// The deadline of the request this process is serving, for the calls it makes
// to other tiers on that request's behalf (service-client.js). A tier that
// received a signed call with SERVICE_DEADLINE_HEADER (requireServiceIdentity
// fixes req.serviceIdentity.deadlineAt at arrival) runs the rest of the
// request inside bindServiceCallDeadline, and an outbound call then spends at
// most the time left: the remote retrieval client (remote-retrieval.js) passes
// getServiceCallBudgetMs() as its timeoutMs, and a call made after the
// deadline fails at once with a timeout instead of doing work nobody waits
// for. Without a bound deadline nothing changes: calls use their configured
// timeout.

const deadlineStorage = new AsyncLocalStorage();

const toDeadlineAt = (value) => {
  const parsed = Number(value);

  return value !== null && value !== undefined && Number.isFinite(parsed) ? parsed : null;
};

/** Runs `callback` with `deadlineAt` (epoch ms, or null for none) as the call deadline. */
export const runWithServiceCallDeadline = (deadlineAt, callback) =>
  deadlineStorage.run({ deadlineAt: toDeadlineAt(deadlineAt) }, callback);

/**
 * Express middleware: the rest of the request runs with the caller's deadline
 * (req.serviceIdentity.deadlineAt) as the call deadline. Mount after
 * requireServiceIdentity; a request without a deadline runs without one.
 */
export const bindServiceCallDeadline = (req, res, next) =>
  runWithServiceCallDeadline(req?.serviceIdentity?.deadlineAt ?? null, next);

/** The bound deadline (epoch ms), or null. */
export const getServiceCallDeadline = () => deadlineStorage.getStore()?.deadlineAt ?? null;

/**
 * The budget for one outbound call: `timeoutMs` capped by what is left of the
 * bound deadline. 0 once the deadline has passed; `timeoutMs` without one.
 */
export const getServiceCallBudgetMs = (timeoutMs, { now = Date.now } = {}) => {
  const deadlineAt = getServiceCallDeadline();

  if (deadlineAt === null) {
    return timeoutMs;
  }

  return Math.max(0, Math.min(timeoutMs, Math.floor(deadlineAt - now())));
};
