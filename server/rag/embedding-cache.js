import {
  getActiveDatabaseTenant,
  getDatabaseTenantContext,
} from "./postgres-tenant.js";
import { embedQuery } from "./openai.js";
import {
  getQueryEmbeddingCacheMaxEntries,
  getQueryEmbeddingCacheScope,
  getQueryEmbeddingCacheTtlMs,
  isQueryEmbeddingCacheEnabled,
} from "./config.js";
import {
  getRequestCancellation,
  getRequestSignal,
  isRequestCancelledError,
  REQUEST_CANCELLATION_REASONS,
  RequestCancelledError,
  runOutsideRequestDeadline,
} from "./request-deadline.js";
import {
  chargeRunUsage,
  createRunUsageCapture,
  getActiveRunUsage,
  getCapturedRunUsageEvents,
  runWithRunUsage,
} from "./run-usage.js";
import {
  getConfiguredEmbeddingSpace,
  isSameQuerySpace,
  peekServingQueryEmbeddingSpace,
  resolveServingQueryEmbeddingSpace,
} from "./vector-store-pgvector-versions.js";

// The per-process query embedding cache, keyed by embedding space and text.
//
// A query is embedded in the space the index serves: the configured model for
// the local and Qdrant providers and for a pgvector index whose active version
// lives in the configured space, and the active version's own model, task
// prefix and width when that version is pinned to another one
// (resolveServingQueryEmbeddingSpace). One embedding per query either way; the
// configured space is embedded only when something asks for it. Every returned
// vector is tagged with its space (getQueryVectorEmbeddingSpace), so the
// pgvector search uses it as is when it matches the version it searches, and
// embeds the text again only when the pointer moved in between.
//
// One LRU for every space, bounded by RAG_EMBEDDING_CACHE_MAX entries with a
// RAG_EMBEDDING_CACHE_TTL_MS lifetime; RAG_EMBEDDING_CACHE_ENABLED=false turns
// caching off (a query is then embedded once per call, still in one space, in
// the caller's own context). By default (RAG_EMBEDDING_CACHE_SCOPE=shared)
// the cache is shared by every tenant of the process: an embedding of a text
// is not tenant data. A hit is still observable, though: it answers without a
// model call, so it is measurably faster, and a tenant could time its own
// query to learn whether another tenant recently asked exactly that text ("Is
// Acme acquiring Beta?"). RAG_EMBEDDING_CACHE_SCOPE=tenant closes that timing
// channel by keying cached vectors by the same tenant partition flights use
// (describeFlightTenant), at the cost of one model call per tenant per text.
// Flights, the space tagging and the vector-to-space map are the same under
// both scopes.
//
// Concurrent callers of one key share one embedding call, a flight. The call
// serves all of them, so it runs for none of them in particular:
//   - It is detached from the request that happened to start it: no request
//     deadline or signal (runOutsideRequestDeadline) and no caller's run usage
//     meter (a capture, below). Its own timeout bounds it (the model client's,
//     or the gateway client's), never one caller's deadline. Three contexts
//     are kept on purpose: the starting caller's database tenant, so the model
//     gateway signs the call as that tenant and its workspace quota and usage
//     ledger count it, as they did before flights were detached (the text is
//     the same for every caller, so nothing of another tenant's reaches the
//     call; signing it as the system would let query embeddings bypass every
//     tenant quota); the OpenTelemetry context, so the call's span stays in
//     the trace of the request that started it (observability, not
//     authority); and a model gateway call context, which exists only inside
//     the gateway (which never embeds through this cache) and without which a
//     call the gateway serves would be sent back out to a gateway.
//   - Each caller waits under its own deadline and signal: a cancelled caller
//     rejects at once with its own RequestCancelledError while the call goes
//     on for the others. The call is aborted only when its last caller has
//     gone, as a lone caller's cancellation always aborted its own call, and
//     the next caller of the key starts a new flight.
//   - Usage (run-usage.js): one model call is charged once, to one run: the
//     run of the earliest caller still waiting when the call succeeds, which
//     is the run that would have made the call had the requests come one after
//     another. Every other caller is charged what a cache hit is charged,
//     nothing, because no model call was made for it. A call that fails, or
//     that every caller abandoned, is charged to nobody, like any failed call.
//     Its LLMOps event is recorded once, without a run, when the call ends.
//   A flight caches its vector only while it is still the key's flight; one
//   every caller abandoned, or one from before resetEmbeddingCache, caches
//   nothing.

let cache = new Map();
let inflightPromises = new Map();
// vector -> the space it was embedded in. Weak: a vector nobody holds is gone.
let vectorSpaces = new WeakMap();

const toEmbeddingSpaceRequest = (space) => ({
  dimensions: space.dimensions,
  documentPrefix: space.documentPrefix,
  identity: space.identity,
  model: space.model,
  queryPrefix: space.queryPrefix,
});

// The cache holds the model's own vectors only: the query adapter
// (rag/query-adapter.js) adapts a copy at the retrieval seam, so it is not
// part of the key. Under RAG_EMBEDDING_CACHE_SCOPE=tenant the tenant partition
// joins the head of the key (before the first newline; the partition is JSON,
// so it holds no raw newline or NUL), and the space key stays its first field
// (describeEmbeddingCache). Under `shared` the key is unchanged.
const buildCacheKey = (space, query, partition = null) =>
  [space.key, space.model, space.queryPrefix, ...(partition === null ? [] : [partition])].join(
    "\u0000"
  ) + `\n${query}`;

// Evicting a cached entry leaves a flight of the same key alone: the flight
// settles its own callers and caches its result when it ends.
const evictExpired = (now) => {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
};

const evictLru = () => {
  const maxEntries = getQueryEmbeddingCacheMaxEntries();
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
};

/** The space a vector from embedQueryCached was embedded in, or null for any other vector. */
export const getQueryVectorEmbeddingSpace = (vector) =>
  vector && typeof vector === "object" ? vectorSpaces.get(vector) ?? null : null;

// The configured space goes through the exact configured path (a stand-in
// provider gets one argument, the real client the configured prefix); another
// space names its model and prefixes. `signal` is a flight's own: a stand-in
// provider never receives it, the real and gateway clients do.
const embedInSpace = async (query, space, signal = undefined) => {
  const vector = isSameQuerySpace(space, getConfiguredEmbeddingSpace())
    ? await embedQuery(query, signal ? { signal } : undefined)
    : await embedQuery(query, {
        embeddingSpace: toEmbeddingSpaceRequest(space),
        ...(signal ? { signal } : {}),
      });

  if (vector && typeof vector === "object") {
    vectorSpaces.set(vector, space);
  }

  return vector;
};

// The cancellation a waiter's own signal carries, read the way
// getRequestCancellation reads it. Computed from the signal itself: an abort
// listener runs in the context of whoever aborted, not in the waiter's.
const toWaiterCancellation = (signal) =>
  isRequestCancelledError(signal.reason)
    ? signal.reason
    : new RequestCancelledError(REQUEST_CANCELLATION_REASONS.clientCancelled, { cause: signal.reason });

const isCurrentFlight = (flight) => inflightPromises.get(flight.key) === flight;

const releaseWaiter = (waiter) => {
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
};

const leaveFlight = (flight, waiter, cancellation) => {
  if (!flight.waiters.delete(waiter)) {
    return;
  }

  releaseWaiter(waiter);
  waiter.reject(cancellation);

  if (flight.waiters.size === 0 && !flight.settled) {
    // Nobody waits for the call any more: stop it, and let the next caller of
    // the key start a flight of its own. The abort reason is a cancellation,
    // so the model-call guard counts the call as neither failure nor success.
    if (isCurrentFlight(flight)) {
      inflightPromises.delete(flight.key);
    }

    flight.controller.abort(cancellation);
  }
};

// Joins `flight` as the current caller, with that caller's signal and run
// meter. Resolves with the vector, or rejects with the call's error or with
// the caller's own cancellation, whichever comes first.
const joinFlight = (flight) => {
  const signal = getRequestSignal();
  const runUsage = getActiveRunUsage();

  return new Promise((resolve, reject) => {
    const waiter = { onAbort: null, reject, resolve, runUsage, signal };

    if (signal) {
      waiter.onAbort = () => leaveFlight(flight, waiter, toWaiterCancellation(signal));
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }

    flight.waiters.add(waiter);
  });
};

const settleFlight = (flight, { error = null, ok, vector = null }) => {
  flight.settled = true;

  if (isCurrentFlight(flight)) {
    inflightPromises.delete(flight.key);
    cache.delete(flight.cacheKey);

    if (ok) {
      cache.set(flight.cacheKey, { vector, expiresAt: Date.now() + getQueryEmbeddingCacheTtlMs() });
      evictExpired(Date.now());
      evictLru();
    }
  }

  // Join order: the first entry is the earliest caller still waiting.
  const waiters = [...flight.waiters];

  flight.waiters.clear();
  waiters.forEach(releaseWaiter);

  if (!ok) {
    waiters.forEach((waiter) => waiter.reject(error));
    return;
  }

  const [payer] = waiters;

  if (payer) {
    for (const event of getCapturedRunUsageEvents(flight.meter)) {
      chargeRunUsage(payer.runUsage, event);
    }
  }

  waiters.forEach((waiter) => waiter.resolve(vector));
};

// The tenant partition of a flight: the bound database tenant's exact pair, or
// the non-tenant context (system, unscoped, unbound) it runs in.
const describeFlightTenant = () => {
  const tenant = getActiveDatabaseTenant();

  return tenant
    ? `tenant:${JSON.stringify([tenant.userId, tenant.workspaceId])}`
    : `context:${getDatabaseTenantContext()}`;
};

// Starts the flight's call outside every caller's request (see the header).
const launchFlight = (flight, query, space) => {
  const call = runOutsideRequestDeadline(() =>
    runWithRunUsage(flight.meter, () => embedInSpace(query, space, flight.controller.signal))
  );

  call.then(
    (vector) => settleFlight(flight, { ok: true, vector }),
    (error) => settleFlight(flight, { error, ok: false })
  );
};

/**
 * The query's vector in `space`, or in the space the index serves when no
 * space is given. Concurrent callers of one key share one request, which runs
 * detached from each of them (see the header).
 */
export const embedQueryCached = async (query, { space = null } = {}) => {
  // Known without I/O almost always (the pointer snapshot inside its TTL);
  // otherwise the pointer read the search would make next anyway.
  const target = space ?? peekServingQueryEmbeddingSpace() ?? (await resolveServingQueryEmbeddingSpace());

  if (!isQueryEmbeddingCacheEnabled()) {
    return embedInSpace(query, target);
  }

  // Read per call, so an unknown value fails the embedding (and refuses the
  // start, app.js), never falls back to the shared cache.
  const key = buildCacheKey(
    target,
    query,
    getQueryEmbeddingCacheScope() === "tenant" ? describeFlightTenant() : null
  );
  const now = Date.now();

  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) {
    cache.delete(key);
    cache.set(key, existing);
    return existing.vector;
  }

  // A caller already cancelled neither starts nor joins a call: its signal
  // will not fire again, so nothing would ever take it off the flight.
  const cancellation = getRequestCancellation();

  if (cancellation) {
    throw cancellation;
  }

  // Flights are shared within one tenant only: a flight runs as its starter's
  // tenant (the model gateway's identity, quota and ledger), so a starter's
  // quota refusal or policy error must never reach another tenant's request.
  // The finished vector is cached under `key`: for every tenant under the
  // `shared` scope, for the flight's own tenant partition under `tenant`.
  const flightKey = `${describeFlightTenant()}\u0000${key}`;
  const inflight = inflightPromises.get(flightKey);

  if (inflight) {
    return joinFlight(inflight);
  }

  const flight = {
    cacheKey: key,
    controller: new AbortController(),
    key: flightKey,
    meter: createRunUsageCapture(),
    settled: false,
    waiters: new Set(),
  };

  inflightPromises.set(flightKey, flight);

  // The starter joins before the call starts, so it is the first waiter.
  const waiting = joinFlight(flight);

  launchFlight(flight, query, target);
  return waiting;
};

/** Entries currently cached, per space key (tests and diagnostics). */
export const describeEmbeddingCache = () => {
  const bySpace = {};

  for (const key of cache.keys()) {
    const spaceKey = key.slice(0, key.indexOf("\u0000"));

    bySpace[spaceKey] = (bySpace[spaceKey] ?? 0) + 1;
  }

  return { bySpace, entries: cache.size, maxEntries: getQueryEmbeddingCacheMaxEntries() };
};

/** The callers each flight in progress is serving, in start order (tests and diagnostics). */
export const describeEmbeddingFlights = () =>
  [...inflightPromises.values()].map((flight) => ({ waiters: flight.waiters.size }));

export const resetEmbeddingCache = () => {
  cache = new Map();
  inflightPromises = new Map();
  vectorSpaces = new WeakMap();
};
