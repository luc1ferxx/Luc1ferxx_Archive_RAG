// The per-workspace retention policy: the `retention_policy` jsonb column of a
// tenant registry workspace (migration 036; written only through
// rag/tenant-registry.js, which validates it here) and read by the retention
// sweep (rag/retention.js). One definition for both sides, so the registry
// accepts exactly what the sweep reads.
//
// Format: a JSON object whose keys name data types and whose values are whole
// numbers of days, for example
//
//   { "agentRuns": 30, "tasks": 90, "workspaceArtifacts": 365, "feedback": 0 }
//
//   key                 data type             global setting it adjusts
//   agentRuns           finished agent runs   AGENT_RUN_RETENTION_DAYS
//   tasks               finished tasks        TASK_RETENTION_DAYS
//   workspaceArtifacts  archived artifacts    WORKSPACE_ARTIFACT_RETENTION_DAYS
//   feedback            answer feedback       FEEDBACK_RETENTION_DAYS
//
// - A value is an integer from 0 to MAX_WORKSPACE_RETENTION_DAYS. 0 keeps that
//   workspace's data of the type forever; any other value replaces the global
//   number of days for that workspace (shorter or longer).
// - A key left out (and the empty policy {}) means the global setting applies.
// - A policy only adjusts a type that is enabled globally (its variable above
//   0); a type at 0 is not swept for anyone.
// - The RAG observability files are per host, not per workspace, so they have
//   no key.
// - The registry refuses every other key and every other value (a numeric
//   string, a fraction, a negative number, { "days": n }), so a typo is an
//   error at registration rather than a setting the sweep silently ignores.
//   The sweep reads only these keys and ignores a value it cannot read (a row
//   written around the registry, by hand in SQL), so the global setting
//   applies to that type.

// Data type id (rag/retention.js RETENTION_DATA_TYPES) -> policy key.
export const WORKSPACE_RETENTION_POLICY_KEYS = Object.freeze({
  agent_runs: "agentRuns",
  feedback: "feedback",
  tasks: "tasks",
  workspace_artifacts: "workspaceArtifacts",
});

const POLICY_KEY_LIST = Object.freeze(Object.values(WORKSPACE_RETENTION_POLICY_KEYS));
const POLICY_KEY_SET = new Set(POLICY_KEY_LIST);

// One hundred years: far beyond any real policy, and small enough that the
// cutoff (now minus the days) is always a representable date.
export const MAX_WORKSPACE_RETENTION_DAYS = 36_500;

const isPolicyObject = (value) =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const isPolicyDays = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_WORKSPACE_RETENTION_DAYS;

/**
 * Why `policy` is not a valid retention policy, or null when it is. The
 * message names the accepted keys and values and never quotes the input.
 */
export const describeWorkspaceRetentionPolicyProblem = (policy) => {
  if (!isPolicyObject(policy)) {
    return "retentionPolicy must be a JSON object.";
  }

  for (const [key, value] of Object.entries(policy)) {
    if (!POLICY_KEY_SET.has(key)) {
      return `retentionPolicy keys must be among ${POLICY_KEY_LIST.join(", ")}.`;
    }

    if (!isPolicyDays(value)) {
      return `retentionPolicy.${key} must be a whole number of days from 0 to ${MAX_WORKSPACE_RETENTION_DAYS} (0 keeps the data forever).`;
    }
  }

  return null;
};

const parsePolicy = (value) => {
  if (isPolicyObject(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);

      return isPolicyObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return null;
};

/**
 * The days a workspace's policy sets for `dataType` (a RETENTION_DATA_TYPES
 * id), or undefined when it sets none or a value the format above does not
 * allow (ignored rather than read as 0). `policy` is the stored object or its
 * JSON text.
 */
export const readWorkspaceRetentionPolicyDays = (policy, dataType) => {
  const parsed = parsePolicy(policy);
  const key = Object.hasOwn(WORKSPACE_RETENTION_POLICY_KEYS, String(dataType ?? ""))
    ? WORKSPACE_RETENTION_POLICY_KEYS[dataType]
    : null;

  if (!parsed || !key || !Object.hasOwn(parsed, key)) {
    return undefined;
  }

  return isPolicyDays(parsed[key]) ? parsed[key] : undefined;
};

/** The stored policy as an object, or null when it is not one. */
export const parseWorkspaceRetentionPolicy = parsePolicy;
