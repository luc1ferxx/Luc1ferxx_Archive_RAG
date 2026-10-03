import { AsyncLocalStorage } from "node:async_hooks";

// The deadline and cancellation signal of the request this async chain serves.
//
// One store per request: { deadlineAt, signal }. deadlineAt is epoch ms (null
// for none); signal aborts with a RequestCancelledError when the deadline
// passes or, when the caller asked for it, when the client goes away. Every
// outbound call the request makes reads it:
//   - service-client calls (remote-retrieval.js, model-gateway/client.js)
//     spend getRequestBudgetMs(own timeout) and pass the signal, so the next
//     tier receives the shrunken deadline in its header and the call is
//     aborted when the request is cancelled;
//   - direct model calls (openai.js), the cross-encoder (reranker.js) and web
//     search (chat-mcp.js) add the signal to their own timeout.
// The agent run itself checks throwIfRequestCancelled() at its safe points
// (before a stage, a step or a graph node starts, and before finalization),
// so a cancelled run stops there with a terminal status instead of starting
// more work. A Capability that writes (approvalPolicy.writesWorkspace) runs
// outside the store once started (capabilities/registry.js): it is never cut
// mid-effect, its step completes, and the run stops at the next safe point.
// Database statements never read the signal, so a step's outcome is always
// recorded.
//
// Nothing is bound unless a request asks for it: with no deadline and no
// disconnect cancellation the routes never enter this storage, and every
// getter answers "no deadline, no signal", exactly as before. Background work
// (scheduled tasks, startup recovery) never inherits a request's store:
// runOutsideRequestDeadline detaches it, and job-orchestrator.js schedules
// every task run through it.
//
// Errors raised here name the reason and a stable code only.

export const REQUEST_CANCELLATION_REASONS = Object.freeze({
  clientCancelled: "client_cancelled",
  deadlineExceeded: "deadline_exceeded",
});

export const REQUEST_CANCELLATION_CODES = Object.freeze({
  clientCancelled: "AGENT_CLIENT_CANCELLED",
  deadlineExceeded: "AGENT_DEADLINE_EXCEEDED",
});

// nginx's "client closed request": never seen by the client that left, but
// it keeps an access log honest about why the answer was not sent.
export const CLIENT_CLOSED_REQUEST_STATUS = 499;

const CANCELLATION_DETAILS = Object.freeze({
  [REQUEST_CANCELLATION_REASONS.clientCancelled]: Object.freeze({
    code: REQUEST_CANCELLATION_CODES.clientCancelled,
    message: "The client disconnected before the answer was complete.",
    retryable: false,
    status: CLIENT_CLOSED_REQUEST_STATUS,
  }),
  [REQUEST_CANCELLATION_REASONS.deadlineExceeded]: Object.freeze({
    code: REQUEST_CANCELLATION_CODES.deadlineExceeded,
    message: "The request deadline passed before the answer was complete.",
    retryable: true,
    status: 504,
  }),
});

/**
 * Why a request stopped early: its deadline passed (504
 * AGENT_DEADLINE_EXCEEDED, retryable) or its client left (499
 * AGENT_CLIENT_CANCELLED). `runFailure` is what the agent run records with
 * its terminal status. Deliberately not named TimeoutError or AbortError:
 * openai-client.js and reranker.js turn those into ETIMEDOUT, which the retry
 * policy would retry.
 */
export class RequestCancelledError extends Error {
  constructor(reason = REQUEST_CANCELLATION_REASONS.deadlineExceeded, { cause } = {}) {
    const detail =
      CANCELLATION_DETAILS[reason] ?? CANCELLATION_DETAILS[REQUEST_CANCELLATION_REASONS.deadlineExceeded];

    super(detail.message, cause === undefined ? undefined : { cause });
    this.name = "RequestCancelledError";
    this.code = detail.code;
    this.reason = CANCELLATION_DETAILS[reason] ? reason : REQUEST_CANCELLATION_REASONS.deadlineExceeded;
    this.retryable = detail.retryable;
    this.status = detail.status;
    this.runFailure = { code: this.code, reason: this.reason, retryable: this.retryable };
  }
}

export const isRequestCancelledError = (error) => error instanceof RequestCancelledError;

const storage = new AsyncLocalStorage();
const NO_REQUEST = Object.freeze({ deadlineAt: null, signal: null });
// The longest delay setTimeout honours (2^31 - 1 ms, about 24.8 days).
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const toDeadlineAt = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
};

const readStore = () => storage.getStore() ?? NO_REQUEST;

/** The bound deadline (epoch ms), or null. */
export const getRequestDeadline = () => readStore().deadlineAt;

/** The bound cancellation signal, or null when the request has none. */
export const getRequestSignal = () => readStore().signal;

/**
 * The budget for one outbound call: `timeoutMs` capped by what is left of the
 * bound deadline (rounded up, so a call cut by it ends at or after the
 * deadline, never a millisecond before). 0 once the deadline has passed;
 * `timeoutMs` without a deadline. A `timeoutMs` that is not a positive number
 * means "no limit of its own": the remaining time, or `timeoutMs` as given.
 */
export const getRequestBudgetMs = (timeoutMs, { now = Date.now } = {}) => {
  const deadlineAt = getRequestDeadline();

  if (deadlineAt === null) {
    return timeoutMs;
  }

  const remainingMs = Math.max(0, Math.ceil(deadlineAt - now()));
  const ownTimeoutMs = Number(timeoutMs);

  return Number.isFinite(ownTimeoutMs) && ownTimeoutMs > 0
    ? Math.min(ownTimeoutMs, remainingMs)
    : remainingMs;
};

/**
 * The cancellation of the bound request, or null while it may continue: the
 * signal's reason once it aborted, or a deadline error once the deadline has
 * passed (a timer may not have fired yet). `cause` is kept on a new error.
 */
export const getRequestCancellation = ({ cause, now = Date.now } = {}) => {
  const { deadlineAt, signal } = readStore();

  if (signal?.aborted) {
    return isRequestCancelledError(signal.reason)
      ? signal.reason
      : new RequestCancelledError(REQUEST_CANCELLATION_REASONS.clientCancelled, { cause });
  }

  if (deadlineAt !== null && now() >= deadlineAt) {
    return new RequestCancelledError(REQUEST_CANCELLATION_REASONS.deadlineExceeded, { cause });
  }

  return null;
};

/** A safe point: throws the request's cancellation, if it has one. */
export const throwIfRequestCancelled = () => {
  const cancellation = getRequestCancellation();

  if (cancellation) {
    throw cancellation;
  }
};

/**
 * `signal` plus the bound request's signal: whichever aborts first aborts the
 * call. Without a bound signal, `signal` is returned as it is (undefined
 * stays undefined), so callers outside a request pass exactly what they did.
 */
export const withRequestSignal = (signal) => {
  const requestSignal = getRequestSignal();

  if (!requestSignal) {
    return signal;
  }

  return signal ? AbortSignal.any([signal, requestSignal]) : requestSignal;
};

/**
 * `{ signal, timeout }` request options for a client that takes both (the MCP
 * SDK's callTool): the bound request's signal and `defaultTimeoutMs` capped by
 * its deadline. undefined outside a bound request, so such a call is sent with
 * the client's own defaults exactly as before.
 */
export const getRequestCallOptions = (defaultTimeoutMs) => {
  const signal = getRequestSignal();

  return signal ? { signal, timeout: Math.max(1, getRequestBudgetMs(defaultTimeoutMs)) } : undefined;
};

/**
 * One request's cancellation: an AbortController that aborts with a deadline
 * error at `deadlineAt` (a timer that never keeps the process alive) or with
 * `cancel(reason)`. `dispose()` clears the timer; call it once the request is
 * done.
 */
export const createRequestCancellation = ({ deadlineAt = null } = {}) => {
  const controller = new AbortController();
  const boundDeadlineAt = toDeadlineAt(deadlineAt);
  let timer = null;

  const cancel = (reason = REQUEST_CANCELLATION_REASONS.clientCancelled) => {
    if (!controller.signal.aborted) {
      controller.abort(new RequestCancelledError(reason));
    }
  };

  // A timer longer than MAX_TIMER_DELAY_MS fires after 1 ms in Node (a
  // TimeoutOverflowWarning), which would cancel a request with a far deadline
  // (AGENT_REQUEST_TIMEOUT_MS has no upper bound) at once: such a deadline is
  // waited for in steps.
  const arm = () => {
    const delayMs = Math.max(0, Math.ceil(boundDeadlineAt - Date.now()));

    timer =
      delayMs > MAX_TIMER_DELAY_MS
        ? setTimeout(arm, MAX_TIMER_DELAY_MS)
        : setTimeout(() => cancel(REQUEST_CANCELLATION_REASONS.deadlineExceeded), delayMs);
    timer.unref?.();
  };

  if (boundDeadlineAt !== null) {
    arm();
  }

  return {
    cancel,
    dispose() {
      clearTimeout(timer);
      timer = null;
    },
    signal: controller.signal,
    store: Object.freeze({ deadlineAt: boundDeadlineAt, signal: controller.signal }),
  };
};

const settleWith = (result, dispose) => {
  if (result && typeof result.then === "function") {
    return result.then(
      (value) => {
        dispose();
        return value;
      },
      (error) => {
        dispose();
        throw error;
      }
    );
  }

  dispose();
  return result;
};

/**
 * Runs `callback` with a deadline of its own (epoch ms, or null for none) and
 * a signal that aborts when it passes; the timer is cleared once `callback`
 * (or the promise it returns) settles.
 */
export const runWithRequestDeadline = ({ deadlineAt = null } = {}, callback) => {
  const cancellation = createRequestCancellation({ deadlineAt });
  let result;

  try {
    result = storage.run(cancellation.store, callback);
  } catch (error) {
    cancellation.dispose();
    throw error;
  }

  return settleWith(result, cancellation.dispose);
};

/** Runs `callback` (and everything it starts) under `cancellation`'s store. */
export const runWithRequestCancellation = (cancellation, callback) =>
  storage.run(cancellation.store, callback);

/**
 * Runs `callback` with no request deadline or signal, whatever the caller was
 * bound to: for background work that outlives the request that started it.
 */
export const runOutsideRequestDeadline = (callback) => storage.run(NO_REQUEST, callback);

// --- The agent routes' binding (/chat, /chat/stream, agent-run actions) ------

const DISCONNECT_ON_VALUES = new Set(["1", "on", "true", "yes"]);

/**
 * AGENT_REQUEST_TIMEOUT_MS: the deadline of one agent request in this process,
 * in ms from its arrival. 0, empty or invalid means none (the default).
 */
export const getAgentRequestTimeoutMs = (env = process.env) => {
  const parsed = Number(String(env.AGENT_REQUEST_TIMEOUT_MS ?? "").trim());

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

/**
 * AGENT_CANCEL_ON_DISCONNECT=on: a client that disconnects cancels its run.
 * Off by default, so an abandoned run still completes.
 */
export const isAgentCancelOnDisconnectEnabled = (env = process.env) =>
  DISCONNECT_ON_VALUES.has(String(env.AGENT_CANCEL_ON_DISCONNECT ?? "").trim().toLowerCase());

/**
 * The deadline of an agent request: the calling tier's (the service deadline
 * requireServiceIdentity fixed at arrival) and this process's
 * AGENT_REQUEST_TIMEOUT_MS from `arrivedAt`, whichever comes first; null when
 * neither applies.
 */
export const resolveAgentRequestDeadline = (req, { arrivedAt = Date.now(), env = process.env } = {}) => {
  const serviceDeadlineAt = toDeadlineAt(req?.serviceIdentity?.deadlineAt);
  const timeoutMs = getAgentRequestTimeoutMs(env);
  const localDeadlineAt = timeoutMs > 0 ? arrivedAt + timeoutMs : null;
  const candidates = [serviceDeadlineAt, localDeadlineAt].filter((value) => value !== null);

  return candidates.length > 0 ? Math.min(...candidates) : null;
};

/**
 * Runs one agent request's work (`work()`, which may return a promise) under
 * its deadline and, with AGENT_CANCEL_ON_DISCONNECT on, a cancellation that
 * fires when `res` closes before the answer was written. Without either the
 * work runs unbound, exactly as before.
 */
export const runAgentRequestWithCancellation = (
  req,
  res,
  work,
  { arrivedAt = Date.now(), env = process.env } = {}
) => {
  const deadlineAt = resolveAgentRequestDeadline(req, { arrivedAt, env });
  const cancelOnDisconnect = isAgentCancelOnDisconnectEnabled(env);

  if (deadlineAt === null && !cancelOnDisconnect) {
    return work();
  }

  const cancellation = createRequestCancellation({ deadlineAt });
  // The response's close, not the request's (see routes/chat.js): it fires
  // when the client goes away, or after the answer was written.
  const onClose = () => {
    if (!res.writableFinished) {
      cancellation.cancel(REQUEST_CANCELLATION_REASONS.clientCancelled);
    }
  };

  if (cancelOnDisconnect) {
    res.on("close", onClose);

    // A client that left while an earlier middleware was still awaiting
    // closed the response before this listener existed, and close is not
    // emitted twice: such a request is cancelled from the start.
    if ((res.closed || res.destroyed) && !res.writableFinished) {
      cancellation.cancel(REQUEST_CANCELLATION_REASONS.clientCancelled);
    }
  }

  const dispose = () => {
    cancellation.dispose();
    res.off?.("close", onClose);
  };
  let result;

  try {
    result = runWithRequestCancellation(cancellation, work);
  } catch (error) {
    dispose();
    throw error;
  }

  return settleWith(result, dispose);
};
