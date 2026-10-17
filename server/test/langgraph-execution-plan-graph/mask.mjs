// What two runs on the same runtime never share, and nothing else: random
// ids (UUIDs, also inside run, step and event ids), ISO timestamps, the
// wall-clock measurements (`durationMs`, `latencyMs`, `totalDurationMs`) and
// the graph checkpoint's `digest`, a seal that covers those durations.
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const WALL_CLOCK_KEYS = new Set(["durationMs", "latencyMs", "totalDurationMs"]);

export const maskVolatile = (value, key = "") => {
  if (typeof value === "string") {
    return key === "digest"
      ? "<digest>"
      : value.replace(UUID_PATTERN, "<id>").replace(ISO_TIMESTAMP_PATTERN, "<time>");
  }

  if (typeof value === "number" && WALL_CLOCK_KEYS.has(key)) {
    return "<elapsed>";
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskVolatile(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, maskVolatile(item, name)])
    );
  }

  return value;
};

/** The same masking over raw text (an SSE response body). */
export const maskVolatileText = (text) =>
  String(text)
    .replace(UUID_PATTERN, "<id>")
    .replace(ISO_TIMESTAMP_PATTERN, "<time>")
    .replace(/"(durationMs|latencyMs|totalDurationMs)":-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g, '"$1":"<elapsed>"')
    .replace(/"digest":"[^"]*"/g, '"digest":"<digest>"');

/** Everything a run leaves in an in-memory store, as one comparable object. */
export const projectAgentRun = (run) => ({
  error: run?.error ?? null,
  events: run?.events ?? [],
  result: run?.result ?? null,
  status: run?.status ?? null,
  steps: run?.steps ?? [],
});

/** The fields of a thrown agent error that the route and the run record. */
export const projectAgentError = (error) => ({
  causeCode: error?.causeCode ?? null,
  code: error?.code ?? null,
  dependency: error?.dependency ?? null,
  message: error?.message ?? null,
  name: error?.name ?? null,
  reason: error?.reason ?? null,
  retryable: error?.retryable ?? null,
  status: error?.status ?? null,
});

export const withEnv = async (overrides, work) => {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((name) => [name, process.env[name]])
  );
  const apply = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };

  apply(overrides);

  try {
    return await work();
  } finally {
    apply(previous);
  }
};

// The answer-rate flags change pinned response projections when on
// (test/trajectory-eval.test.mjs pins them off for the same reason), so every
// pass runs with every one of them off whatever the ambient environment says.
export const ANSWER_RATE_FLAGS_OFF = Object.freeze({
  AGENT_FOLLOW_UP_ORIGINAL_QUESTION: undefined,
  AGENT_SINGLE_DOCUMENT_ROUTING: undefined,
  RAG_CLAIM_HEADING_CONTEXT: undefined,
  RAG_CLAIM_INFLECTION: undefined,
  RAG_CLAIM_JUDGE_TEMPERATURE: undefined,
  RAG_CLAIM_SOURCE_INHERITANCE: undefined,
  RAG_QA_GATE_INFLECTION: undefined,
});
