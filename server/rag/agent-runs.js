import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  buildTaskScopeKey,
  normalizeTaskAccessScope,
} from "./tasks.js";
import {
  applyApprovalActionToSteps,
  AGENT_RUN_STEP_STATUSES,
  assertAgentRunStepStatusTransition,
  createUnsupportedAgentRunStepStatusError,
  isKnownAgentRunStepStatus,
  normalizeAgentRunSteps,
  normalizeAgentRunStepStatus,
  queueAgentRunStepRetry,
  updateAgentRunStep,
  upsertAgentRunStep,
} from "./agent-run-steps.js";
import {
  AGENT_RUN_STATUSES,
  assertAgentRunStatusTransition,
  assertInitialAgentRunStatus,
  isRetryableAgentRunStatus,
  normalizeAgentRunStatus,
} from "./agent-run-state-machine.js";
import {
  createAgentRunAlreadyExistsError,
  createAgentRunRevisionConflictError,
  isAgentRunRevisionConflictError,
  normalizeAgentRunRevision,
} from "./agent-run-revision.js";
import { verifyApprovalExecutionSnapshot } from "./capabilities/approval-execution-snapshot.js";

export {
  AGENT_RUN_STATUSES,
  assertAgentRunStatusTransition,
  assertInitialAgentRunStatus,
  isKnownAgentRunStatus,
  isRetryableAgentRunStatus,
  normalizeAgentRunStatus,
} from "./agent-run-state-machine.js";
import { normalizeText } from "../lib/normalize-text.js";

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const normalizeStoredApprovalSnapshot = (snapshot = {}) => {
  const executionInput =
    snapshot.executionInput &&
    typeof snapshot.executionInput === "object" &&
    !Array.isArray(snapshot.executionInput)
      ? snapshot.executionInput
      : null;
  const normalizedSnapshot = {
    gateId: normalizeText(snapshot.gateId),
    capabilityId: normalizeText(snapshot.capabilityId),
    capabilityVersion: normalizeText(snapshot.capabilityVersion),
    approvalObjectHash: normalizeText(snapshot.approvalObjectHash),
    snapshotVersion: Number(snapshot.snapshotVersion),
    executionInput,
  };

  if (
    !normalizedSnapshot.gateId ||
    !normalizedSnapshot.capabilityId ||
    !normalizedSnapshot.capabilityVersion ||
    !normalizedSnapshot.approvalObjectHash ||
    !Number.isInteger(normalizedSnapshot.snapshotVersion) ||
    normalizedSnapshot.snapshotVersion <= 0 ||
    !normalizedSnapshot.executionInput
  ) {
    const error = new Error(
      "Approval snapshot requires gateId, capabilityId, capabilityVersion, approvalObjectHash, a positive snapshotVersion, and object executionInput."
    );
    error.status = 400;
    throw error;
  }

  return normalizedSnapshot;
};

const normalizeStoredApprovalSnapshots = (snapshots = []) => {
  const normalizedSnapshots = toArray(snapshots).map(
    normalizeStoredApprovalSnapshot
  );
  const gateIds = new Set();

  for (const snapshot of normalizedSnapshots) {
    if (gateIds.has(snapshot.gateId)) {
      const error = new Error(
        `Approval snapshot gateId must be unique per update: ${snapshot.gateId}.`
      );
      error.status = 400;
      throw error;
    }

    gateIds.add(snapshot.gateId);
  }

  return normalizedSnapshots;
};

export const AGENT_RUN_ACTIONS = Object.freeze({
  approve: "approve",
  deny: "deny",
});

export const normalizeAgentRunEvent = (event = {}) => {
  const type = normalizeText(event.type ?? event.eventType);

  if (!type) {
    return null;
  }

  return {
    eventId: normalizeText(event.eventId),
    type,
    payload: normalizeRecord(event.payload),
    createdAt: normalizeText(event.createdAt),
  };
};

const normalizeAgentRunEvents = (events) =>
  toArray(events).map(normalizeAgentRunEvent).filter(Boolean);

const normalizeAction = (action) => normalizeText(action).toLowerCase();

const AGENT_RUN_STEP_STATUS_EVENTS = Object.freeze({
  [AGENT_RUN_STEP_STATUSES.completed]: "step_completed",
  [AGENT_RUN_STEP_STATUSES.failed]: "step_failed",
  [AGENT_RUN_STEP_STATUSES.paused]: "step_paused",
  [AGENT_RUN_STEP_STATUSES.running]: "step_started",
});

const normalizeApprovalGateStatus = ({ action }) =>
  normalizeAction(action) === AGENT_RUN_ACTIONS.approve
    ? "approved"
    : "denied";

const getApprovalGateKey = (gate = {}) =>
  normalizeText(gate.id) ||
  `${normalizeText(gate.type)}:${normalizeText(gate.capabilityId)}`;

const mergeAgentRunApprovalGates = (...gateLists) => {
  const gatesById = new Map();

  for (const gate of gateLists.flatMap(toArray)) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      continue;
    }

    const gateKey = getApprovalGateKey(gate);

    if (!gateKey) {
      continue;
    }

    gatesById.set(gateKey, {
      ...(gatesById.get(gateKey) ?? {}),
      ...gate,
    });
  }

  return [...gatesById.values()];
};

const updateApprovalGatesForAction = ({
  action,
  gateId = "",
  gates = [],
  now,
  payload = {},
} = {}) => {
  const normalizedGateId = normalizeText(gateId ?? payload.gateId);
  let matchedGate = null;
  let matched = false;
  const updatedGates = toArray(gates).map((gate) => {
    const gateKey = getApprovalGateKey(gate);
    const isMatch =
      gate.status === "pending" &&
      ((!normalizedGateId && !matched) ||
        (normalizedGateId && gateKey === normalizedGateId));

    if (!isMatch) {
      return gate;
    }

    matched = true;
    matchedGate = {
      ...gate,
      status: normalizeApprovalGateStatus({
        action,
      }),
      decision: normalizeAction(action),
      decidedAt: now(),
      decisionReason: normalizeText(payload.reason),
    };

    return matchedGate;
  });

  return {
    gate: matchedGate,
    gates: updatedGates,
    matched,
  };
};

export const normalizeAgentRun = (run = {}) => {
  const runId = normalizeText(run.runId);
  const goal = normalizeText(run.goal);

  if (!runId || !goal) {
    return null;
  }

  return {
    runId,
    status: normalizeAgentRunStatus(run.status),
    goal,
    input: normalizeRecord(run.input),
    plan: normalizeRecord(run.plan),
    steps: normalizeAgentRunSteps(run.steps),
    observations: toArray(run.observations),
    decisions: toArray(run.decisions),
    approvalGates: structuredClone(toArray(run.approvalGates)),
    result: normalizeRecord(run.result),
    error: normalizeRecord(run.error, null),
    events: normalizeAgentRunEvents(run.events),
    revision: normalizeAgentRunRevision(run.revision),
    createdAt: normalizeText(run.createdAt),
    updatedAt: normalizeText(run.updatedAt),
  };
};

const stripInternalRunFields = (run = {}) => {
  const {
    accessScope,
    revision,
    scopeKey,
    ...publicRun
  } = run;

  return structuredClone(publicRun);
};

const createApprovalBindingError = (message, code) => {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
};

const assertApprovalObjectBinding = ({ gate = {}, payload = {} } = {}) => {
  const expectedHash = normalizeText(gate.approvalObjectHash);
  const suppliedHash = normalizeText(payload.approvalObjectHash);

  if (!expectedHash || !suppliedHash) {
    throw createApprovalBindingError(
      "Approval action requires the approval object hash shown with this gate.",
      "approval_object_hash_required"
    );
  }

  if (suppliedHash !== expectedHash) {
    throw createApprovalBindingError(
      "Approval action does not match the current approval object.",
      "approval_object_hash_mismatch"
    );
  }

  return expectedHash;
};

const assertApprovalSnapshotMetadata = ({ gate = {}, snapshot = {} } = {}) => {
  const matches =
    normalizeText(snapshot.gateId) === normalizeText(gate.id) &&
    normalizeText(snapshot.capabilityId) === normalizeText(gate.capabilityId) &&
    normalizeText(snapshot.capabilityVersion) ===
      normalizeText(gate.capabilityVersion) &&
    normalizeText(snapshot.approvalObjectHash) ===
      normalizeText(gate.approvalObjectHash) &&
    Number(snapshot.snapshotVersion) === Number(gate.snapshotVersion);

  if (!matches) {
    throw createApprovalBindingError(
      "Approval execution snapshot metadata does not match the current gate.",
      "approval_snapshot_metadata_mismatch"
    );
  }
};

const resolveApprovalExecutionSnapshot = async ({
  accessScope = {},
  agentRunStore,
  gate = {},
  runId,
} = {}) => {
  if (typeof agentRunStore.getApprovalSnapshot !== "function") {
    throw createApprovalBindingError(
      "Approval execution snapshot storage is unavailable.",
      "approval_snapshot_store_unavailable"
    );
  }

  const snapshot = await agentRunStore.getApprovalSnapshot({
    accessScope,
    gateId: gate.id,
    runId,
  });

  if (!snapshot) {
    throw createApprovalBindingError(
      "Approval execution snapshot is missing; request approval again.",
      "approval_snapshot_missing"
    );
  }

  assertApprovalSnapshotMetadata({
    gate,
    snapshot,
  });

  return verifyApprovalExecutionSnapshot({
    accessScope,
    approvalObjectHash: gate.approvalObjectHash,
    capabilityId: gate.capabilityId,
    capabilityVersion: gate.capabilityVersion,
    inputPreview: gate.inputPreview,
    privateSnapshot: {
      executionInput: snapshot.executionInput,
      snapshotVersion: snapshot.snapshotVersion,
    },
  });
};

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;
const MIN_LIST_LIMIT = 1;

const normalizePaginationParams = ({ limit, offset } = {}) => {
  let normalizedLimit = Number(limit);

  if (limit === "all") {
    // Internal callers pass "all" when correctness needs the complete result
    // set (status counts, recovery scans). HTTP-facing callers stay capped.
    normalizedLimit = null;
  } else if (!Number.isFinite(normalizedLimit) || normalizedLimit < MIN_LIST_LIMIT) {
    normalizedLimit = DEFAULT_LIST_LIMIT;
  } else if (normalizedLimit > MAX_LIST_LIMIT) {
    normalizedLimit = MAX_LIST_LIMIT;
  } else {
    normalizedLimit = Math.floor(normalizedLimit);
  }

  let normalizedOffset = Number(offset);

  if (!Number.isFinite(normalizedOffset) || normalizedOffset < 0) {
    normalizedOffset = 0;
  } else {
    normalizedOffset = Math.floor(normalizedOffset);
  }

  return { limit: normalizedLimit, offset: normalizedOffset };
};

export const createInMemoryAgentRunStore = ({
  now = () => new Date().toISOString(),
} = {}) => {
  const runs = new Map();
  const eventsByRunKey = new Map();
  const approvalSnapshotsByRunKey = new Map();

  const buildRunKey = ({ accessScope = {}, runId }) =>
    `${buildTaskScopeKey(accessScope)}\u0000${normalizeText(runId)}`;

  const getRunEvents = (runKey) => eventsByRunKey.get(runKey) ?? [];
  const getRunApprovalSnapshots = (runKey) =>
    approvalSnapshotsByRunKey.get(runKey) ?? new Map();
  const cloneApprovalSnapshot = (snapshot) =>
    snapshot ? structuredClone(snapshot) : null;
  const persistApprovalSnapshots = ({ approvalSnapshots = [], runKey } = {}) => {
    const snapshots = new Map(getRunApprovalSnapshots(runKey));

    for (const snapshot of normalizeStoredApprovalSnapshots(
      approvalSnapshots
    )) {
      const gateId = snapshot.gateId;
      const existingSnapshot = snapshots.get(gateId);

      if (existingSnapshot && !isDeepStrictEqual(existingSnapshot, snapshot)) {
        const error = new Error(
          "Agent run approval snapshot conflicts with the immutable stored snapshot."
        );
        error.code = "AGENT_RUN_APPROVAL_SNAPSHOT_CONFLICT";
        error.status = 409;
        throw error;
      }

      snapshots.set(gateId, cloneApprovalSnapshot(snapshot));
    }

    approvalSnapshotsByRunKey.set(runKey, snapshots);
  };

  return {
    initialize() {
      return true;
    },

    create({ accessScope = {}, run } = {}) {
      const normalizedRun = normalizeAgentRun(run);

      if (!normalizedRun) {
        throw new Error("Agent run requires runId and goal.");
      }

      const scope = normalizeTaskAccessScope(accessScope);
      const scopeKey = buildTaskScopeKey(scope);
      const timestamp = now();
      const storedRun = {
        ...normalizedRun,
        revision: normalizeAgentRunRevision(normalizedRun.revision),
        createdAt: normalizedRun.createdAt || timestamp,
        updatedAt: normalizedRun.updatedAt || timestamp,
        accessScope: scope,
        scopeKey,
      };
      const runKey = buildRunKey({
        accessScope: scope,
        runId: storedRun.runId,
      });

      if (runs.has(runKey)) {
        throw createAgentRunAlreadyExistsError({
          runId: storedRun.runId,
        });
      }

      runs.set(runKey, storedRun);
      eventsByRunKey.set(runKey, normalizeAgentRunEvents(normalizedRun.events));
      approvalSnapshotsByRunKey.set(runKey, new Map());

      return {
        ...storedRun,
        events: getRunEvents(runKey),
      };
    },

    async createWithEvent({ accessScope = {}, event, run } = {}) {
      if (!normalizeAgentRunEvent(event)) {
        throw new Error("Agent run event requires a type.");
      }

      const createdRun = await this.create({
        accessScope,
        run,
      });
      const runKey = buildRunKey({
        accessScope,
        runId: createdRun.runId,
      });

      try {
        const storedEvent = await this.appendEvent({
          accessScope,
          event,
          runId: createdRun.runId,
        });

        if (!storedEvent) {
          throw new Error("Agent run creation event could not be recorded.");
        }
      } catch (error) {
        runs.delete(runKey);
        eventsByRunKey.delete(runKey);
        approvalSnapshotsByRunKey.delete(runKey);
        throw error;
      }

      return this.get({
        accessScope,
        runId: createdRun.runId,
      });
    },

    get({ accessScope = {}, runId } = {}) {
      const runKey = buildRunKey({
        accessScope,
        runId,
      });
      const run = runs.get(runKey);

      return run
        ? {
            ...run,
            events: getRunEvents(runKey),
          }
        : null;
    },

    getApprovalSnapshot({ accessScope = {}, gateId, runId } = {}) {
      const runKey = buildRunKey({
        accessScope,
        runId,
      });

      return cloneApprovalSnapshot(
        getRunApprovalSnapshots(runKey).get(normalizeText(gateId))
      );
    },

    list({ accessScope = {}, status = "", limit, offset } = {}) {
      const scopeKey = buildTaskScopeKey(accessScope);
      const normalizedStatus = normalizeText(status);
      const pagination = normalizePaginationParams({ limit, offset });

      return [...runs.values()]
        .filter(
          (run) =>
            run.scopeKey === scopeKey &&
            (!normalizedStatus || run.status === normalizedStatus)
        )
        .sort((left, right) =>
          String(right.updatedAt).localeCompare(String(left.updatedAt))
        )
        .slice(
          pagination.offset,
          pagination.limit === null
            ? undefined
            : pagination.offset + pagination.limit
        );
    },

    listRecoverable({
      statuses = [
        AGENT_RUN_STATUSES.running,
        AGENT_RUN_STATUSES.waitingForUser,
      ],
    } = {}) {
      const normalizedStatuses = new Set(
        toArray(statuses).map(normalizeAgentRunStatus)
      );

      return [...runs.values()]
        .filter((run) => normalizedStatuses.has(run.status))
        .sort((left, right) =>
          String(left.updatedAt).localeCompare(String(right.updatedAt))
        );
    },

    update({
      accessScope = {},
      expectedRevision,
      runId,
      patch = {},
    } = {}) {
      const existingRun = this.get({
        accessScope,
        runId,
      });

      if (!existingRun) {
        return null;
      }

      const currentRevision = normalizeAgentRunRevision(existingRun.revision);
      const normalizedExpectedRevision = normalizeAgentRunRevision(
        expectedRevision
      );

      if (currentRevision !== normalizedExpectedRevision) {
        throw createAgentRunRevisionConflictError({
          actualRevision: currentRevision,
          expectedRevision: normalizedExpectedRevision,
          runId,
        });
      }

      const updatedRun = {
        ...existingRun,
        ...patch,
        input: {
          ...existingRun.input,
          ...normalizeRecord(patch.input),
        },
        plan:
          patch.plan === undefined
            ? existingRun.plan
            : normalizeRecord(patch.plan),
        result: {
          ...existingRun.result,
          ...normalizeRecord(patch.result),
        },
        revision: currentRevision + 1,
        updatedAt: patch.updatedAt || now(),
      };
      const normalizedRun = normalizeAgentRun(updatedRun);
      const runKey = buildRunKey({
        accessScope,
        runId,
      });
      const storedRun = {
        ...normalizedRun,
        accessScope: normalizeTaskAccessScope(accessScope),
        scopeKey: buildTaskScopeKey(accessScope),
      };

      runs.set(runKey, storedRun);

      return {
        ...storedRun,
        events: getRunEvents(runKey),
      };
    },

    async updateWithEvent({
      accessScope = {},
      approvalSnapshots = [],
      event,
      expectedRevision,
      patch = {},
      runId,
    } = {}) {
      if (!normalizeAgentRunEvent(event)) {
        throw new Error("Agent run event requires a type.");
      }

      const runKey = buildRunKey({
        accessScope,
        runId,
      });
      const previousRun = runs.get(runKey);
      const previousEvents = getRunEvents(runKey);
      const previousApprovalSnapshots = new Map(
        getRunApprovalSnapshots(runKey)
      );
      let updatedRun = null;

      try {
        const updateResult = this.update({
          accessScope,
          expectedRevision,
          patch,
          runId,
        });
        updatedRun =
          updateResult && typeof updateResult.then === "function"
            ? await updateResult
            : updateResult;

        if (!updatedRun) {
          return null;
        }

        persistApprovalSnapshots({
          approvalSnapshots,
          runKey,
        });
        const eventResult = this.appendEvent({
          accessScope,
          event,
          runId,
        });
        const storedEvent =
          eventResult && typeof eventResult.then === "function"
            ? await eventResult
            : eventResult;

        if (!storedEvent) {
          throw new Error("Agent run update event could not be recorded.");
        }

        return this.get({
          accessScope,
          runId,
        });
      } catch (error) {
        const currentRun = runs.get(runKey);
        const canRollback =
          previousRun &&
          updatedRun &&
          currentRun &&
          normalizeAgentRunRevision(currentRun.revision) ===
            normalizeAgentRunRevision(updatedRun.revision);

        if (canRollback) {
          runs.set(runKey, previousRun);
          eventsByRunKey.set(runKey, previousEvents);
          approvalSnapshotsByRunKey.set(
            runKey,
            previousApprovalSnapshots
          );
        }

        throw error;
      }
    },

    appendEvent({ accessScope = {}, event, runId } = {}) {
      const existingRun = this.get({
        accessScope,
        runId,
      });

      if (!existingRun) {
        return null;
      }

      const runKey = buildRunKey({
        accessScope,
        runId,
      });
      const events = getRunEvents(runKey);
      const timestamp = now();
      const storedEvent = normalizeAgentRunEvent({
        ...event,
        eventId: event.eventId || `${normalizeText(runId)}:${events.length + 1}`,
        createdAt: event.createdAt || timestamp,
      });

      if (!storedEvent) {
        return null;
      }

      eventsByRunKey.set(runKey, [...events, storedEvent]);
      runs.set(runKey, {
        ...runs.get(runKey),
        updatedAt: timestamp,
      });

      return storedEvent;
    },
  };
};

const buildRunError = (error) => {
  if (!error) {
    return null;
  }

  return {
    message: error instanceof Error ? error.message : normalizeText(error),
    name: error instanceof Error ? error.name : "Error",
  };
};

const buildStepError = (error) => {
  if (!error) {
    return undefined;
  }

  if (error && typeof error === "object" && !Array.isArray(error)) {
    return {
      message: normalizeText(error.message) || "Step failed.",
      name: normalizeText(error.name) || "Error",
    };
  }

  return {
    message: normalizeText(error) || "Step failed.",
    name: "Error",
  };
};

const buildStepPatch = ({
  detail,
  error,
  input,
  label,
  output,
  type,
} = {}) => {
  const patch = {};

  if (type !== undefined) {
    patch.type = type;
  }
  if (label !== undefined) {
    patch.label = label;
  }
  if (input !== undefined) {
    patch.input = input;
  }
  if (output !== undefined) {
    patch.output = output;
  }
  if (detail !== undefined) {
    patch.detail = detail;
  }
  if (error !== undefined) {
    patch.error = buildStepError(error);
  }

  return patch;
};

const buildNewStepTimestamps = ({ status, timestamp } = {}) => ({
  completedAt:
    status === AGENT_RUN_STEP_STATUSES.completed ||
    status === AGENT_RUN_STEP_STATUSES.failed
      ? timestamp
      : "",
  createdAt: timestamp,
  pausedAt: status === AGENT_RUN_STEP_STATUSES.paused ? timestamp : "",
  startedAt:
    status === AGENT_RUN_STEP_STATUSES.pending ? "" : timestamp,
  updatedAt: timestamp,
});

const getRunStepEventType = ({ eventType, status } = {}) =>
  normalizeText(eventType) ||
  AGENT_RUN_STEP_STATUS_EVENTS[status] ||
  "step_updated";

const NEW_AGENT_RUN_STEP_STATUSES = new Set([
  AGENT_RUN_STEP_STATUSES.paused,
  AGENT_RUN_STEP_STATUSES.pending,
  AGENT_RUN_STEP_STATUSES.running,
]);

const createInvalidNewRunStepStatusError = (status) => {
  const error = new Error(
    `New agent run steps must start as running, pending, or paused: ${status}.`
  );
  error.status = 409;
  return error;
};

const getNewRunStepStatus = (status) => {
  if (status === undefined) {
    return AGENT_RUN_STEP_STATUSES.pending;
  }
  if (!isKnownAgentRunStepStatus(status)) {
    throw createUnsupportedAgentRunStepStatusError(status);
  }

  const normalizedStatus = normalizeAgentRunStepStatus(status);

  if (!NEW_AGENT_RUN_STEP_STATUSES.has(normalizedStatus)) {
    throw createInvalidNewRunStepStatusError(normalizedStatus);
  }

  return normalizedStatus;
};

const getRequestedRunStepStatus = (status) =>
  status === undefined ? undefined : normalizeAgentRunStepStatus(status);

const assertNewRunStepEventType = ({ eventType, status } = {}) => {
  if (status !== AGENT_RUN_STEP_STATUSES.pending || normalizeText(eventType)) {
    return;
  }

  const error = new Error(
    "Pending agent run step creation requires an explicit eventType."
  );
  error.status = 400;
  throw error;
};

const AGENT_RUN_STEP_MUTABLE_STATUSES = new Set([
  AGENT_RUN_STATUSES.running,
  AGENT_RUN_STATUSES.waitingForUser,
]);
const TERMINAL_AGENT_RUN_STATUSES = new Set([
  AGENT_RUN_STATUSES.canceled,
  AGENT_RUN_STATUSES.completed,
  AGENT_RUN_STATUSES.failed,
]);

const assertAgentRunAcceptsStepMutation = (status) => {
  const normalizedStatus = normalizeAgentRunStatus(status);

  if (AGENT_RUN_STEP_MUTABLE_STATUSES.has(normalizedStatus)) {
    return;
  }

  const error = new Error(
    `Agent run steps cannot be changed while run is ${normalizedStatus}.`
  );
  error.status = 409;
  throw error;
};

const TERMINAL_AGENT_RUN_STEP_STATUSES = new Set([
  AGENT_RUN_STEP_STATUSES.completed,
  AGENT_RUN_STEP_STATUSES.failed,
  AGENT_RUN_STEP_STATUSES.skipped,
]);
const ACTIVE_AGENT_RUN_STEP_STATUSES = new Set([
  AGENT_RUN_STEP_STATUSES.paused,
  AGENT_RUN_STEP_STATUSES.pending,
  AGENT_RUN_STEP_STATUSES.running,
]);

const mergePersistedRunStepSnapshot = ({
  currentStep,
  incomingStep,
} = {}) => {
  if (!currentStep) {
    return incomingStep;
  }

  const currentStepIsTerminal = TERMINAL_AGENT_RUN_STEP_STATUSES.has(
    currentStep.status
  );

  if (!currentStepIsTerminal) {
    assertAgentRunStepStatusTransition({
      from: currentStep.status,
      to: incomingStep.status,
    });
  }
  const hasPersistedStepType = currentStep.type !== "step";
  const hasPersistedLabel =
    currentStep.label !== "step" || hasPersistedStepType;

  return {
    ...incomingStep,
    type: hasPersistedStepType ? currentStep.type : incomingStep.type,
    kind: hasPersistedStepType ? currentStep.kind : incomingStep.kind,
    status: currentStepIsTerminal ? currentStep.status : incomingStep.status,
    label: hasPersistedLabel ? currentStep.label : incomingStep.label,
    summary: currentStep.summary || incomingStep.summary,
    detail:
      currentStep.detail || incomingStep.detail
        ? {
            ...(incomingStep.detail ?? {}),
            ...(currentStep.detail ?? {}),
          }
        : null,
    parentStepId: currentStep.parentStepId || incomingStep.parentStepId,
    traceStepId: currentStep.traceStepId || incomingStep.traceStepId,
    approvalGateId:
      currentStep.approvalGateId || incomingStep.approvalGateId,
    capabilityId: currentStep.capabilityId || incomingStep.capabilityId,
    capabilityVersion:
      currentStep.capabilityVersion || incomingStep.capabilityVersion,
    input: currentStep.input ?? incomingStep.input,
    attempt: currentStep.attempt,
    retryOfStepId:
      currentStep.retryOfStepId || incomingStep.retryOfStepId,
    decision: currentStep.decision || incomingStep.decision,
    error:
      currentStepIsTerminal
        ? currentStep.status === AGENT_RUN_STEP_STATUSES.failed
          ? currentStep.error ?? incomingStep.error
          : currentStep.error
        : currentStep.error ?? incomingStep.error,
    output:
      currentStepIsTerminal
        ? currentStep.status === AGENT_RUN_STEP_STATUSES.completed
          ? currentStep.output ?? incomingStep.output
          : currentStep.output
        : currentStep.output ?? incomingStep.output,
    createdAt: currentStep.createdAt || incomingStep.createdAt,
    startedAt: currentStep.startedAt || incomingStep.startedAt,
    pausedAt: currentStep.pausedAt || incomingStep.pausedAt,
    completedAt: currentStep.completedAt || incomingStep.completedAt,
    updatedAt: currentStep.updatedAt || incomingStep.updatedAt,
  };
};

const mergeAgentRunStepSnapshots = ({
  currentSteps = [],
  incomingSteps = [],
} = {}) => {
  const normalizedCurrentSteps = normalizeAgentRunSteps(currentSteps);
  const normalizedIncomingSteps = normalizeAgentRunSteps(incomingSteps);
  const currentStepsById = new Map(
    normalizedCurrentSteps.map((step) => [step.id, step])
  );

  // Completion callers provide the full logical trace snapshot in display
  // order. A CAS retry may reveal newer persisted-only steps; append those,
  // but never let the older snapshot regress a terminal execution lifecycle.
  const mergedSteps = normalizedIncomingSteps.reduce(
    (steps, step) =>
      upsertAgentRunStep({
        steps,
        step: mergePersistedRunStepSnapshot({
          currentStep: currentStepsById.get(step.id),
          incomingStep: step,
        }),
      }),
    normalizedCurrentSteps
  );
  const mergedStepsById = new Map(
    mergedSteps.map((step) => [step.id, step])
  );
  const orderedStepIds = [
    ...normalizedIncomingSteps,
    ...normalizedCurrentSteps,
  ].map((step) => step.id);

  return [...new Set(orderedStepIds)]
    .map((stepId) => mergedStepsById.get(stepId))
    .filter(Boolean);
};

const getActiveAgentRunStep = (steps = []) =>
  normalizeAgentRunSteps(steps).find((step) =>
    ACTIVE_AGENT_RUN_STEP_STATUSES.has(step.status)
  ) ?? null;

const createActiveRunStepCompletionConflictError = ({ status, step } = {}) => {
  const error = new Error(
    `Agent run cannot become ${status} with concurrent active step ${step.id} (${step.status}).`
  );
  error.code = "AGENT_RUN_ACTIVE_STEP_CONFLICT";
  error.status = 409;
  return error;
};

const DEFAULT_AGENT_RUN_MUTATION_RETRIES = 32;

export const createAgentRunService = ({
  agentRunStore = createInMemoryAgentRunStore(),
} = {}) => {
  const mutateStoredRun = async ({
    accessScope = {},
    allowRetryTransition = false,
    maxRetries = 0,
    mutate,
    runId,
  } = {}) => {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const existingRun = await agentRunStore.get?.({
        accessScope,
        runId,
      });

      if (!existingRun) {
        return {
          applied: false,
          run: null,
          value: null,
        };
      }

      const mutation = await mutate(stripInternalRunFields(existingRun));

      if (!mutation) {
        return {
          applied: false,
          run: stripInternalRunFields(existingRun),
          value: null,
        };
      }

      const patch = mutation.patch ?? mutation;
      const approvalSnapshots = toArray(mutation.approvalSnapshots);

      if (patch.status !== undefined) {
        assertAgentRunStatusTransition({
          allowRetryTransition,
          from: existingRun.status,
          to: patch.status,
        });
      }

      if (
        TERMINAL_AGENT_RUN_STATUSES.has(existingRun.status) &&
        !allowRetryTransition
      ) {
        const error = new Error(
          `Terminal agent run cannot be updated: ${existingRun.status}.`
        );
        error.status = 409;
        throw error;
      }

      try {
        if (approvalSnapshots.length > 0 && !agentRunStore.updateWithEvent) {
          throw new Error(
            "Agent run store cannot atomically persist approval execution snapshots."
          );
        }

        const updateOptions = {
          accessScope,
          expectedRevision: normalizeAgentRunRevision(existingRun.revision),
          runId,
          patch,
        };
        const updatedRun =
          mutation.event && agentRunStore.updateWithEvent
            ? await agentRunStore.updateWithEvent({
                ...updateOptions,
                approvalSnapshots,
                event: mutation.event,
              })
            : await agentRunStore.update?.(updateOptions);

        if (updatedRun && mutation.event && !agentRunStore.updateWithEvent) {
          await agentRunStore.appendEvent?.({
            accessScope,
            event: mutation.event,
            runId,
          });
        }

        return {
          applied: Boolean(updatedRun),
          run: updatedRun ? stripInternalRunFields(updatedRun) : null,
          value: mutation.value ?? null,
        };
      } catch (error) {
        if (
          !isAgentRunRevisionConflictError(error) ||
          attempt >= maxRetries
        ) {
          throw error;
        }
      }
    }

    throw createAgentRunRevisionConflictError({
      runId,
    });
  };

  return {
  async initialize() {
    return agentRunStore.initialize?.() ?? true;
  },

  async createRun({
    accessScope = {},
    goal,
    input = {},
    plan = {},
    runId = randomUUID(),
    status = AGENT_RUN_STATUSES.running,
  } = {}) {
    const initialStatus = assertInitialAgentRunStatus(status);
    const runSnapshot = {
      runId,
      status: initialStatus,
      goal,
      input,
      plan,
    };
    const creationEvent = {
      type: "run_created",
      payload: {
        status: initialStatus,
      },
    };
    const run = agentRunStore.createWithEvent
      ? await agentRunStore.createWithEvent({
          accessScope,
          event: creationEvent,
          run: runSnapshot,
        })
      : await agentRunStore.create({
          accessScope,
          run: runSnapshot,
        });

    if (!agentRunStore.createWithEvent) {
      await this.appendRunEvent({
        accessScope,
        runId: run.runId,
        ...creationEvent,
      });
    }

    return stripInternalRunFields(
      await agentRunStore.get({
        accessScope,
        runId: run.runId,
      })
    );
  },

  async appendRunEvent({
    accessScope = {},
    runId,
    type,
    payload = {},
  } = {}) {
    return agentRunStore.appendEvent?.({
      accessScope,
      runId,
      event: {
        type,
        payload,
      },
    });
  },

  async updateRun({
    accessScope = {},
    runId,
    patch = {},
  } = {}) {
    const mutation = await mutateStoredRun({
      accessScope,
      runId,
      mutate: () => ({
        patch,
      }),
    });

    return mutation.run;
  },

  async completeRun({
    accessScope = {},
    approvalSnapshots = [],
    approvalGates = [],
    decisions = [],
    observations = [],
    result = {},
    runId,
    status = AGENT_RUN_STATUSES.completed,
    steps,
  } = {}) {
    const pendingApprovalGate = toArray(approvalGates).find(
      (gate) => gate?.status === "pending"
    );
    const completionEventType =
      status === AGENT_RUN_STATUSES.waitingForUser && pendingApprovalGate
        ? "approval_gate_created"
        : status === AGENT_RUN_STATUSES.waitingForUser
          ? "run_waiting_for_user"
        : status === AGENT_RUN_STATUSES.failed
          ? "run_failed"
          : status === AGENT_RUN_STATUSES.canceled
            ? "run_canceled"
            : "run_completed";
    const mutation = await mutateStoredRun({
      accessScope,
      maxRetries: DEFAULT_AGENT_RUN_MUTATION_RETRIES,
      runId,
      mutate: (existingRun) => {
        if (TERMINAL_AGENT_RUN_STATUSES.has(existingRun.status)) {
          assertAgentRunStatusTransition({
            from: existingRun.status,
            to: status,
          });
          return null;
        }

        const mergedSteps =
          steps === undefined
            ? existingRun.steps
            : mergeAgentRunStepSnapshots({
                currentSteps: existingRun.steps,
                incomingSteps: steps,
              });
        const activeStep = TERMINAL_AGENT_RUN_STATUSES.has(status)
          ? getActiveAgentRunStep(mergedSteps)
          : null;

        if (activeStep) {
          throw createActiveRunStepCompletionConflictError({
            status,
            step: activeStep,
          });
        }

        const patch = {
          approvalGates: mergeAgentRunApprovalGates(
            existingRun.approvalGates,
            approvalGates
          ),
          decisions,
          observations,
          result,
          status,
        };

        if (steps !== undefined) {
          patch.steps = mergedSteps;
        }

        return {
          approvalSnapshots,
          event: {
            type: completionEventType,
            payload: {
              ...(pendingApprovalGate
                ? {
                    approvalObjectHash:
                      pendingApprovalGate.approvalObjectHash ?? null,
                    capabilityId: pendingApprovalGate.capabilityId ?? null,
                    gateId: pendingApprovalGate.id ?? null,
                  }
                : {}),
              status,
            },
          },
          patch,
        };
      },
    });
    const run = mutation.run;

    return (
      (await this.getRun({
        accessScope,
        runId,
      })) ?? run
    );
  },

  async cancelRun({ accessScope = {}, reason = "", runId } = {}) {
    const normalizedReason = normalizeText(reason);
    const mutation = await mutateStoredRun({
      accessScope,
      runId,
      mutate: (existingRun) => {
        if (
          ![
            AGENT_RUN_STATUSES.running,
            AGENT_RUN_STATUSES.waitingForUser,
          ].includes(existingRun.status)
        ) {
          const error = new Error(
            "Only running or waiting agent runs can be canceled."
          );
          error.status = 409;
          throw error;
        }

        return {
          event: {
            type: "run_canceled",
            payload: {
              reason: normalizedReason,
              status: AGENT_RUN_STATUSES.canceled,
            },
          },
          patch: {
            result: {
              canceled: true,
              cancelReason: normalizedReason,
            },
            status: AGENT_RUN_STATUSES.canceled,
          },
        };
      },
    });

    if (!mutation.run) {
      const error = new Error("Agent run not found.");
      error.status = 404;
      throw error;
    }

    return (
      (await this.getRun({
        accessScope,
        runId,
      })) ?? mutation.run
    );
  },

  async failRun({ accessScope = {}, error, runId } = {}) {
    const runError = buildRunError(error);
    const mutation = await mutateStoredRun({
      accessScope,
      runId,
      mutate: () => ({
        event: {
          type: "run_failed",
          payload: {
            error: runError,
          },
        },
        patch: {
          error: runError,
          status: AGENT_RUN_STATUSES.failed,
        },
      }),
    });
    const run = mutation.run;

    return (
      (await this.getRun({
        accessScope,
        runId,
      })) ?? run
    );
  },

  async applyApprovalAction({
    accessScope = {},
    action,
    gateId = "",
    payload = {},
    runId,
  } = {}) {
    const normalizedAction = normalizeAction(action);
    const argumentGateId = normalizeText(gateId);
    const payloadGateId = normalizeText(payload.gateId);
    const normalizedGateId = argumentGateId || payloadGateId;

    if (!Object.values(AGENT_RUN_ACTIONS).includes(normalizedAction)) {
      const error = new Error(`Unsupported agent run action: ${action}`);
      error.status = 400;
      throw error;
    }

    if (!normalizedGateId) {
      const error = new Error("gateId is required for approval actions.");
      error.status = 400;
      throw error;
    }

    if (
      argumentGateId &&
      payloadGateId &&
      argumentGateId !== payloadGateId
    ) {
      const error = new Error("Approval action contains conflicting gate ids.");
      error.status = 400;
      throw error;
    }

    const mutation = await mutateStoredRun({
      accessScope,
      runId,
      mutate: async (existingRun) => {
        if (existingRun.status !== AGENT_RUN_STATUSES.waitingForUser) {
          const error = new Error("Agent run is not waiting for user input.");
          error.status = 409;
          throw error;
        }

        const pendingGate = toArray(existingRun.approvalGates).find(
          (gate) =>
            gate?.status === "pending" &&
            getApprovalGateKey(gate) === normalizedGateId
        );

        if (!pendingGate) {
          const error = new Error("Pending approval gate not found.");
          error.status = 404;
          throw error;
        }

        const approvalObjectHash = assertApprovalObjectBinding({
          gate: pendingGate,
          payload,
        });

        if (normalizedAction === AGENT_RUN_ACTIONS.approve) {
          await resolveApprovalExecutionSnapshot({
            accessScope,
            agentRunStore,
            gate: pendingGate,
            runId,
          });
        }

        const updateResult = updateApprovalGatesForAction({
          action: normalizedAction,
          gateId: normalizedGateId,
          gates: existingRun.approvalGates,
          now: () => new Date().toISOString(),
          payload,
        });

        if (!updateResult.matched) {
          const error = new Error("Approval gate not found.");
          error.status = 404;
          throw error;
        }

        const nextStatus =
          normalizedAction === AGENT_RUN_ACTIONS.approve
            ? AGENT_RUN_STATUSES.running
            : AGENT_RUN_STATUSES.completed;
        const stepUpdateResult = applyApprovalActionToSteps({
          action: normalizedAction,
          gate: updateResult.gate,
          steps: existingRun.steps,
        });
        const resultPatch =
          normalizedAction === AGENT_RUN_ACTIONS.deny
            ? {
                approvalDenied: true,
                deniedGateId: getApprovalGateKey(updateResult.gate),
                status: 200,
              }
            : {};

        return {
          event: {
            type:
              normalizedAction === AGENT_RUN_ACTIONS.approve
                ? "approval_gate_approved"
                : "approval_gate_denied",
            payload: {
              approvalObjectHash,
              capabilityId: updateResult.gate?.capabilityId ?? null,
              gateId: getApprovalGateKey(updateResult.gate),
              reason: normalizeText(payload.reason),
              stepId: stepUpdateResult.gateStep?.id ?? null,
            },
          },
          patch: {
            approvalGates: updateResult.gates,
            result: resultPatch,
            status: nextStatus,
            steps: stepUpdateResult.steps,
          },
          value: {
            gate: updateResult.gate,
            gateStep: stepUpdateResult.gateStep,
          },
        };
      },
    });

    if (!mutation.run) {
      const error = new Error("Agent run not found.");
      error.status = 404;
      throw error;
    }

    return (
      (await this.getRun({
        accessScope,
        runId,
      })) ?? mutation.run
    );
  },

  async getApprovedCapabilityExecution({
    accessScope = {},
    approvalObjectHash,
    gateId,
    runId,
  } = {}) {
    const normalizedGateId = normalizeText(gateId);
    const existingRun = await agentRunStore.get?.({
      accessScope,
      runId,
    });

    if (!existingRun) {
      const error = new Error("Agent run not found.");
      error.status = 404;
      throw error;
    }

    if (existingRun.status !== AGENT_RUN_STATUSES.running) {
      throw createApprovalBindingError(
        "Approved capability execution requires a running agent run.",
        "approval_execution_run_not_running"
      );
    }

    const gate = toArray(existingRun.approvalGates).find(
      (candidate) =>
        candidate?.status === "approved" &&
        normalizeText(candidate.id) === normalizedGateId
    );

    if (!gate) {
      throw createApprovalBindingError(
        "Approved capability gate not found.",
        "approved_gate_not_found"
      );
    }

    const expectedHash = assertApprovalObjectBinding({
      gate,
      payload: {
        approvalObjectHash,
      },
    });
    const input = await resolveApprovalExecutionSnapshot({
      accessScope,
      agentRunStore,
      gate,
      runId,
    });

    return {
      approvalObjectHash: expectedHash,
      capabilityId: normalizeText(gate.capabilityId),
      capabilityVersion: normalizeText(gate.capabilityVersion),
      gate: structuredClone(gate),
      input,
    };
  },

  async updateRunStep({
    accessScope = {},
    eventType = "step_updated",
    patch = {},
    runId,
    status,
    stepId,
  } = {}) {
    const mutation = await mutateStoredRun({
      accessScope,
      maxRetries: DEFAULT_AGENT_RUN_MUTATION_RETRIES,
      runId,
      mutate: (existingRun) => {
        assertAgentRunAcceptsStepMutation(existingRun.status);

        const updateResult = updateAgentRunStep({
          patch,
          status,
          stepId,
          steps: existingRun.steps,
        });

        return updateResult.matched
          ? {
              event: {
                type: eventType,
                payload: {
                  status: updateResult.step.status,
                  stepId: updateResult.step.id,
                },
              },
              patch: {
                steps: updateResult.steps,
              },
              value: updateResult.step,
            }
          : null;
      },
    });

    if (!mutation.applied) {
      return null;
    }

    return (
      (await this.getRun({
        accessScope,
        runId,
      })) ?? mutation.run
    );
  },

  async recordRunStep({
    accessScope = {},
    detail,
    error,
    eventType = "",
    input,
    label,
    output,
    runId,
    status,
    stepId,
    type,
  } = {}) {
    const normalizedStepId = normalizeText(stepId);

    if (!normalizedStepId) {
      return null;
    }

    const patch = buildStepPatch({
      detail,
      error,
      input,
      label,
      output,
      type,
    });
    const mutation = await mutateStoredRun({
      accessScope,
      maxRetries: DEFAULT_AGENT_RUN_MUTATION_RETRIES,
      runId,
      mutate: (existingRun) => {
        assertAgentRunAcceptsStepMutation(existingRun.status);

        const existingSteps = normalizeAgentRunSteps(existingRun.steps);
        const existingStep = existingSteps.find(
          (step) => step.id === normalizedStepId
        );
        let requestedStatus = getRequestedRunStepStatus(status);
        let nextSteps = existingSteps;
        let recordedStep = null;

        if (existingStep) {
          const updateResult = updateAgentRunStep({
            patch,
            status,
            stepId: normalizedStepId,
            steps: existingSteps,
          });
          nextSteps = updateResult.steps;
          recordedStep = updateResult.step;
        } else {
          const timestamp = new Date().toISOString();
          const nextStatus = getNewRunStepStatus(status);
          requestedStatus = nextStatus;
          assertNewRunStepEventType({
            eventType,
            status: nextStatus,
          });
          recordedStep = {
            ...buildNewStepTimestamps({
              status: nextStatus,
              timestamp,
            }),
            ...patch,
            id: normalizedStepId,
            status: nextStatus,
          };
          nextSteps = upsertAgentRunStep({
            steps: existingSteps,
            step: recordedStep,
          });
          recordedStep = nextSteps.find(
            (step) => step.id === normalizedStepId
          );
        }

        const typeToRecord = getRunStepEventType({
          eventType,
          status: requestedStatus,
        });

        return {
          event: {
            type: typeToRecord,
            payload: {
              status: recordedStep.status,
              stepId: recordedStep.id,
            },
          },
          patch: {
            steps: nextSteps,
          },
          value: {
            requestedStatus,
            step: recordedStep,
          },
        };
      },
    });

    if (!mutation.applied) {
      return null;
    }

    return (
      (await this.getRun({
        accessScope,
        runId,
      })) ?? mutation.run
    );
  },

  async retryStep({ accessScope = {}, runId, stepId } = {}) {
    const mutation = await mutateStoredRun({
      allowRetryTransition: true,
      accessScope,
      runId,
      mutate: (existingRun) => {
        if (!isRetryableAgentRunStatus(existingRun.status)) {
          const error = new Error(
            "Agent run steps can only be retried from completed or failed runs."
          );
          error.status = 409;
          throw error;
        }

        const retryResult = queueAgentRunStepRetry({
          stepId,
          steps: existingRun.steps,
        });

        if (!retryResult.matched) {
          const error = new Error("Agent run step not found.");
          error.status = 404;
          throw error;
        }

        return {
          event: {
            type: "step_retry_queued",
            payload: {
              retryOfStepId: retryResult.retryStep.retryOfStepId,
              stepId: retryResult.retryStep.id,
            },
          },
          patch: {
            status: AGENT_RUN_STATUSES.running,
            steps: retryResult.steps,
          },
          value: retryResult.retryStep,
        };
      },
    });

    if (!mutation.run) {
      const error = new Error("Agent run not found.");
      error.status = 404;
      throw error;
    }

    return (
      (await this.getRun({
        accessScope,
        runId,
      })) ?? mutation.run
    );
  },

  async getRun({ accessScope = {}, runId } = {}) {
    const run = await agentRunStore.get?.({
      accessScope,
      runId,
    });

    return run ? stripInternalRunFields(run) : null;
  },

  async listRuns({ accessScope = {}, status = "", limit, offset } = {}) {
    return {
      runs: toArray(
        await agentRunStore.list?.({
          accessScope,
          status,
          limit,
          offset,
        })
      ).map(stripInternalRunFields),
    };
  },

  async listRecoverableRuns({
    includeAccessScope = false,
    statuses = [
      AGENT_RUN_STATUSES.running,
      AGENT_RUN_STATUSES.waitingForUser,
    ],
  } = {}) {
    const stripRun = (run) => {
      const publicRun = stripInternalRunFields(run);

      return includeAccessScope
        ? {
            ...publicRun,
            accessScope: run.accessScope,
          }
        : publicRun;
    };

    return {
      runs: toArray(
        await agentRunStore.listRecoverable?.({
          statuses,
        })
      ).map(stripRun),
    };
  },
  };
};
