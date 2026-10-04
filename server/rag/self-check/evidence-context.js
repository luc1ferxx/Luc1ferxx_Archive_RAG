// Exact memo for one claim-support evaluation, or for one /chat.
//
// The claim check is pure: it reads the answer text, the citations, the
// comparison summary and three flags (evaluate.js), and nothing else. Every
// claim re-reads the same citations, though, so the same sentence splitting,
// alias derivation and numeric normalisation run once per claim and per
// segment, and a /chat runs the whole check again for the selection between
// the primary and follow-up answers and again for the finalizer.
//
// A context caches the results of those pure functions by their exact input
// (never by a normalised form: normalizeNumericSyntax is not idempotent, and
// callers that run it twice keep both passes). Results are copied on the way
// in and on the way out, because callers mutate what they get back
// (haveSameNumericOccurrences writes roleTerms onto the facts it builds).
//
// A context lives as long as its owner: evaluateClaimSupport creates one per
// call, and the document loop creates one per /chat and hands it to the
// finalizer through the ragResult it returns. There is no process-wide cache.
//
// The active context is a module variable rather than AsyncLocalStorage
// because evaluateClaimSupport is synchronous: it is set for the duration of
// one call and restored before the call returns, so no other request's code
// can run while it is set.

const DEFAULT_MAX_ENTRIES_PER_TABLE = 4096;

let activeContext = null;
let claimSupportObserver = null;
const contextsByOwner = new WeakMap();

export const createSelfCheckEvidenceContext = ({
  enabled = true,
  maxEntriesPerTable = DEFAULT_MAX_ENTRIES_PER_TABLE,
} = {}) => ({
  enabled: enabled !== false,
  maxEntriesPerTable,
  tables: new Map(),
  stats: { hits: {}, misses: {} },
});

export const isSelfCheckEvidenceContext = (value) =>
  Boolean(value) &&
  typeof value === "object" &&
  value.tables instanceof Map &&
  Boolean(value.stats);

export const getActiveSelfCheckEvidenceContext = () => activeContext;

export const runWithSelfCheckEvidenceContext = (context, action) => {
  if (!isSelfCheckEvidenceContext(context) || context === activeContext) {
    return action();
  }

  const previous = activeContext;
  activeContext = context;

  try {
    return action();
  } finally {
    activeContext = previous;
  }
};

const countStat = (context, kind, table) => {
  context.stats[kind][table] = (context.stats[kind][table] ?? 0) + 1;
};

/**
 * Returns compute() for `key` in `table` of the active context, computing it
 * once per exact key. A key that is not a string, or no active (enabled)
 * context, computes directly. `copy` must return a value the caller may
 * mutate without touching the cached one.
 */
export const memoizeInEvidenceContext = (table, key, compute, copy = (value) => value) => {
  const context = activeContext;

  if (!context?.enabled || typeof key !== "string") {
    return compute();
  }

  let entries = context.tables.get(table);

  if (!entries) {
    entries = new Map();
    context.tables.set(table, entries);
  }

  if (entries.has(key)) {
    countStat(context, "hits", table);
    return copy(entries.get(key));
  }

  countStat(context, "misses", table);
  const value = compute();

  if (entries.size < context.maxEntriesPerTable) {
    entries.set(key, copy(value));
  }

  return value;
};

export const copyArray = (values) => values.slice();

export const copyObjectArray = (values) => values.map((value) => ({ ...value }));

export const copyStructured = (value) => structuredClone(value);

// The per-/chat context travels with the document RAG result the loop returns,
// so the finalizer can reuse what the loop already checked. Weakly held: it is
// gone with the result object.
export const bindSelfCheckEvidenceContext = (owner, context) => {
  if (owner && typeof owner === "object" && isSelfCheckEvidenceContext(context)) {
    contextsByOwner.set(owner, context);
  }

  return owner;
};

export const getBoundSelfCheckEvidenceContext = (owner) =>
  owner && typeof owner === "object" ? contextsByOwner.get(owner) ?? null : null;

// The finalizer is the context's last reader in a /chat; releasing it there
// keeps a result that outlives the request (a stored execution state) from
// holding the memo.
export const releaseSelfCheckEvidenceContext = (owner) => {
  if (owner && typeof owner === "object") {
    contextsByOwner.delete(owner);
  }
};

export const getSelfCheckEvidenceContextStats = (context) => ({
  hits: { ...(context?.stats?.hits ?? {}) },
  misses: { ...(context?.stats?.misses ?? {}) },
});

// A stable, exact serialisation of the claim check's input. Anything it cannot
// represent exactly (a Map, a class instance, a function, a cycle) makes the
// key null, and the check is then computed without the result cache.
const UNSERIALIZABLE = Symbol("unserializable");

const serializeExact = (value, seen) => {
  if (value === undefined) {
    return "u";
  }

  if (value === null) {
    return "n";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "t" : "f";
    case "number":
      return Object.is(value, -0) ? "-0" : `#${String(value)}`;
    case "object":
      break;
    default:
      throw UNSERIALIZABLE;
  }

  if (seen.has(value)) {
    throw UNSERIALIZABLE;
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw UNSERIALIZABLE;
      }

      return `[${value.map((entry) => serializeExact(entry, seen)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);

    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw UNSERIALIZABLE;
    }

    return `{${Object.keys(value)
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!("value" in descriptor)) {
          throw UNSERIALIZABLE;
        }

        return `${JSON.stringify(key)}:${serializeExact(descriptor.value, seen)}`;
      })
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
};

/**
 * The content key of one claim check: answer text, every citation field (the
 * attached evidence included), which citations are the same object (the check
 * tells repeated references apart by index), the comparison summary, and the
 * three flags evaluateClaimSupport reads.
 */
export const buildClaimSupportContentKey = ({
  answerText,
  citations,
  comparisonAnalysisSummary,
  flags,
} = {}) => {
  if (!Array.isArray(citations)) {
    return null;
  }

  try {
    return serializeExact(
      {
        answerText,
        citationIdentity: citations.map((citation) => citations.indexOf(citation)),
        citations,
        comparisonAnalysisSummary,
        flags,
      },
      new Set()
    );
  } catch (error) {
    if (error === UNSERIALIZABLE) {
      return null;
    }

    throw error;
  }
};

// Test seam: called with the input and the result of every evaluateClaimSupport
// call, so a test can check memoised results against an unmemoised run.
export const setClaimSupportObserverForTests = (observer) => {
  claimSupportObserver = typeof observer === "function" ? observer : null;
};

export const notifyClaimSupportObserver = (input, result) => {
  if (claimSupportObserver) {
    claimSupportObserver(input, result);
  }
};
