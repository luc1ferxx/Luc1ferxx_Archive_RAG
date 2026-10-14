// LangSmith must never run (docs/adr/0001-langgraph-runtime.md, constraint 5).
//
// @langchain/core enables its LangSmith tracer from the environment alone: any
// of the tracing variables below set to "true" attaches a LangChainTracer that
// ships every run's inputs and outputs -- questions, prompts, document text --
// to a third party (node_modules/@langchain/core/dist/utils/callbacks.js).
// LANGCHAIN_VERBOSE adds a console handler that prints the same content into
// the logs. Tracing stays on OpenTelemetry (rag/tracing.js), which records ids
// and counts only, so these variables are refused instead of ignored: the
// server does not start with one set, and every adapter call re-checks, since
// the environment can change after start-up.
//
// What the per-call check covers, and what it cannot. LangChain attaches the
// tracer when a runnable's entry point configures its callbacks, before the
// runnable's own work, and a composed runnable does that with the whole
// chain input before any of its steps runs (RunnableSequence.invoke calls
// handleChainStart first). So the check protects:
//   - the entry points of every runnable an adapter in this directory builds
//     (guardRunnableEntryPoints below), and
//   - every runnable made from one of them through its own methods (pipe,
//     withConfig, withRetry, ...), which is guarded the same way.
// It cannot protect a composition that some other runnable starts:
// RunnableSequence.from([...]), otherRunnable.pipe(adapter), or a LangGraph
// graph.invoke configure their callbacks -- and hand their input to the
// tracer -- before any adapter code runs; the adapter's refusal then comes
// too late. Every such outer entry (phase 2's graph and chain invocations)
// must call assertLangSmithTracingDisabled itself before it starts. The
// start-up refusal in server.js covers a variable set before the process
// starts.
export const LANGSMITH_TRACING_VARIABLES = Object.freeze([
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
  "LANGCHAIN_VERBOSE",
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
]);

export const LANGSMITH_TRACING_ENABLED_CODE = "LANGSMITH_TRACING_ENABLED";

// LangChain itself only reacts to the exact string "true"; refusing any casing
// errs on the side of the refusal.
export const findEnabledLangSmithTracing = (env = process.env) =>
  LANGSMITH_TRACING_VARIABLES.filter(
    (name) => String(env?.[name] ?? "").trim().toLowerCase() === "true"
  );

export const assertLangSmithTracingDisabled = (env = process.env) => {
  const enabled = findEnabledLangSmithTracing(env);

  if (enabled.length > 0) {
    const error = new Error(
      `LangSmith tracing must stay off; unset ${enabled.join(", ")}. ` +
        "Tracing goes through OpenTelemetry (OTEL_TRACING_ENABLED)."
    );
    error.code = LANGSMITH_TRACING_ENABLED_CODE;
    throw error;
  }
};

// Runnable entry points that configure callbacks with the caller's input, or
// reach one that does. Their call shapes are kept: an async method stays
// async (a refusal is a rejection, as LangChain's own errors are), a generator
// stays a generator (it refuses on the first next()), and streamEvents, which
// returns its stream synchronously, refuses synchronously.
const ASYNC_ENTRY_POINTS = Object.freeze(["batch", "invoke", "stream"]);
const GENERATOR_ENTRY_POINTS = Object.freeze(["streamLog", "transform"]);
const SYNC_ENTRY_POINTS = Object.freeze(["streamEvents"]);
// Methods that return a new runnable around this one. The new runnable's own
// entry point runs first (and configures callbacks with the input), so it is
// guarded too, recursively: pipe(...).pipe(...) stays guarded.
const COMPOSING_METHODS = Object.freeze([
  "asTool",
  "assign",
  "bind",
  "map",
  "pick",
  "pipe",
  "withConfig",
  "withFallbacks",
  "withListeners",
  "withRetry",
]);

const guardedRunnables = new WeakSet();

const replaceMethod = (runnable, name, buildReplacement) => {
  const original = runnable[name];

  if (typeof original === "function") {
    // Called with the runnable as `this`, as the prototype method would be;
    // a class's own overrides and super calls are unchanged.
    runnable[name] = buildReplacement((args) => original.apply(runnable, args));
  }
};

/**
 * Puts the LangSmith check in front of a LangChain runnable's own entry points
 * and of every runnable its composing methods return (see the header for what
 * this cannot cover). Instance properties only: the class is not touched.
 * Returns the same runnable; guarding twice is a no-op.
 */
export const guardRunnableEntryPoints = (runnable) => {
  if (
    !runnable ||
    (typeof runnable !== "object" && typeof runnable !== "function") ||
    guardedRunnables.has(runnable)
  ) {
    return runnable;
  }

  guardedRunnables.add(runnable);

  for (const name of ASYNC_ENTRY_POINTS) {
    replaceMethod(runnable, name, (call) => async (...args) => {
      assertLangSmithTracingDisabled();
      return call(args);
    });
  }

  for (const name of GENERATOR_ENTRY_POINTS) {
    replaceMethod(runnable, name, (call) => async function* (...args) {
      assertLangSmithTracingDisabled();
      yield* call(args);
    });
  }

  for (const name of SYNC_ENTRY_POINTS) {
    replaceMethod(runnable, name, (call) => (...args) => {
      assertLangSmithTracingDisabled();
      return call(args);
    });
  }

  for (const name of COMPOSING_METHODS) {
    replaceMethod(runnable, name, (call) => (...args) => {
      assertLangSmithTracingDisabled();
      return guardRunnableEntryPoints(call(args));
    });
  }

  return runnable;
};
