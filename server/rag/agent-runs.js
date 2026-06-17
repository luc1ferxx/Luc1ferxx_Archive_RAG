import { randomUUID } from "node:crypto";
import {
  buildTaskScopeKey,
  normalizeTaskAccessScope,
} from "./tasks.js";
import {
  applyApprovalActionToSteps,
  normalizeAgentRunSteps,
  queueAgentRunStepRetry,
  updateAgentRunStep,
} from "./agent-run-steps.js";
import {
  AGENT_RUN_STATUSES,
  assertAgentRunStatusTransition,
  assertInitialAgentRunStatus,
  isRetryableAgentRunStatus,
  normalizeAgentRunStatus,
} from "./agent-run-state-machine.js";

export {
  AGENT_RUN_STATUSES,
  assertAgentRunStatusTransition,
  assertInitialAgentRunStatus,
  isKnownAgentRunStatus,
  isRetryableAgentRunStatus,
  normalizeAgentRunStatus,
} from "./agent-run-state-machine.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

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

const normalizeApprovalGateStatus = ({ action, status }) => {
  const normalizedStatus = normalizeText(status).toLowerCase();

  if (normalizedStatus) {
    return normalizedStatus;
  }

  return normalizeAction(action) === AGENT_RUN_ACTIONS.approve
    ? "approved"
    : "denied";
};

const getApprovalGateKey = (gate = {}) =>
  normalizeText(gate.id) ||
  `${normalizeText(gate.type)}:${normalizeText(gate.capabilityId)}`;

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
      (!normalizedGateId && gate.status === "pending" && !matched) ||
      (normalizedGateId && gateKey === normalizedGateId);

    if (!isMatch) {
      return gate;
    }

    matched = true;
    matchedGate = {
      ...gate,
      status: normalizeApprovalGateStatus({
        action,
        status: payload.status,
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
    approvalGates: toArray(run.approvalGates),
    result: normalizeRecord(run.result),
    error: normalizeRecord(run.error, null),
    events: normalizeAgentRunEvents(run.events),
    createdAt: normalizeText(run.createdAt),
    updatedAt: normalizeText(run.updatedAt),
  };
};

const stripInternalRunFields = (run = {}) => {
  const {
    accessScope,
    scopeKey,
    ...publicRun
  } = run;

  return publicRun;
};

export const createInMemoryAgentRunStore = ({
  now = () => new Date().toISOString(),
} = {}) => {
  const runs = new Map();
  const eventsByRunKey = new Map();

  const buildRunKey = ({ accessScope = {}, runId }) =>
    `${buildTaskScopeKey(accessScope)}\u0000${normalizeText(runId)}`;

  const getRunEvents = (runKey) => eventsByRunKey.get(runKey) ?? [];

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
        createdAt: normalizedRun.createdAt || timestamp,
        updatedAt: normalizedRun.updatedAt || timestamp,
        accessScope: scope,
        scopeKey,
      };
      const runKey = buildRunKey({
        accessScope: scope,
        runId: storedRun.runId,
      });

      runs.set(runKey, storedRun);
      eventsByRunKey.set(runKey, normalizeAgentRunEvents(normalizedRun.events));

      return {
        ...storedRun,
        events: getRunEvents(runKey),
      };
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

    list({ accessScope = {}, status = "" } = {}) {
      const scopeKey = buildTaskScopeKey(accessScope);
      const normalizedStatus = normalizeText(status);

      return [...runs.values()]
        .filter(
          (run) =>
            run.scopeKey === scopeKey &&
            (!normalizedStatus || run.status === normalizedStatus)
        )
        .sort((left, right) =>
          String(right.updatedAt).localeCompare(String(left.updatedAt))
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

    update({ accessScope = {}, runId, patch = {} } = {}) {
      const existingRun = this.get({
        accessScope,
        runId,
      });

      if (!existingRun) {
        return null;
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

      eventsByRunKey.set(runKey, [...events, storedEvent]);
      this.update({
        accessScope,
        runId,
        patch: {
          updatedAt: timestamp,
        },
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

export const createAgentRunService = ({
  agentRunStore = createInMemoryAgentRunStore(),
} = {}) => ({
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
    const run = await agentRunStore.create({
      accessScope,
      run: {
        runId,
        status: initialStatus,
        goal,
        input,
        plan,
      },
    });

    await this.appendRunEvent({
      accessScope,
      runId: run.runId,
      type: "run_created",
      payload: {
        status: run.status,
      },
    });

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
    allowRetryTransition = false,
    runId,
    patch = {},
  } = {}) {
    const existingRun = await this.getRun({
      accessScope,
      runId,
    });

    if (!existingRun) {
      return null;
    }

    if (patch.status !== undefined) {
      assertAgentRunStatusTransition({
        allowRetryTransition,
        from: existingRun.status,
        to: patch.status,
      });
    }

    const run = await agentRunStore.update?.({
      accessScope,
      runId,
      patch,
    });

    return run ? stripInternalRunFields(run) : null;
  },

  async completeRun({
    accessScope = {},
    approvalGates = [],
    decisions = [],
    observations = [],
    result = {},
    runId,
    status = AGENT_RUN_STATUSES.completed,
    steps,
  } = {}) {
    const patch = {
      approvalGates,
      decisions,
      observations,
      result,
      status,
    };

    if (steps !== undefined) {
      patch.steps = steps;
    }

    const run = await this.updateRun({
      accessScope,
      runId,
      patch,
    });

    await this.appendRunEvent({
      accessScope,
      runId,
      type: status === AGENT_RUN_STATUSES.failed ? "run_failed" : "run_completed",
      payload: {
        status,
      },
    });

    return (
      (await this.getRun({
        accessScope,
        runId,
      })) ?? run
    );
  },

  async failRun({ accessScope = {}, error, runId } = {}) {
    const run = await this.updateRun({
      accessScope,
      runId,
      patch: {
        error: buildRunError(error),
        status: AGENT_RUN_STATUSES.failed,
      },
    });

    await this.appendRunEvent({
      accessScope,
      runId,
      type: "run_failed",
      payload: {
        error: buildRunError(error),
      },
    });

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

    if (!Object.values(AGENT_RUN_ACTIONS).includes(normalizedAction)) {
      const error = new Error(`Unsupported agent run action: ${action}`);
      error.status = 400;
      throw error;
    }

    const existingRun = await this.getRun({
      accessScope,
      runId,
    });

    if (!existingRun) {
      const error = new Error("Agent run not found.");
      error.status = 404;
      throw error;
    }

    if (existingRun.status !== AGENT_RUN_STATUSES.waitingForUser) {
      const error = new Error("Agent run is not waiting for user input.");
      error.status = 409;
      throw error;
    }

    const updateResult = updateApprovalGatesForAction({
      action: normalizedAction,
      gateId,
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
    const run = await this.updateRun({
      accessScope,
      runId,
      patch: {
        approvalGates: updateResult.gates,
        result: resultPatch,
        status: nextStatus,
        steps: stepUpdateResult.steps,
      },
    });

    await this.appendRunEvent({
      accessScope,
      runId,
      type:
        normalizedAction === AGENT_RUN_ACTIONS.approve
          ? "approval_gate_approved"
          : "approval_gate_denied",
      payload: {
        capabilityId: updateResult.gate?.capabilityId ?? null,
        gateId: getApprovalGateKey(updateResult.gate),
        reason: normalizeText(payload.reason),
        stepId: stepUpdateResult.gateStep?.id ?? null,
      },
    });

    return (
      (await this.getRun({
        accessScope,
        runId,
      })) ?? run
    );
  },

  async updateRunStep({
    accessScope = {},
    eventType = "step_updated",
    patch = {},
    runId,
    status,
    stepId,
  } = {}) {
    const existingRun = await this.getRun({
      accessScope,
      runId,
    });

    if (!existingRun) {
      return null;
    }

    const updateResult = updateAgentRunStep({
      patch,
      status,
      stepId,
      steps: existingRun.steps,
    });

    if (!updateResult.matched) {
      return null;
    }

    const run = await this.updateRun({
      accessScope,
      runId,
      patch: {
        steps: updateResult.steps,
      },
    });

    await this.appendRunEvent({
      accessScope,
      runId,
      type: eventType,
      payload: {
        status: updateResult.step.status,
        stepId: updateResult.step.id,
      },
    });

    return (
      (await this.getRun({
        accessScope,
        runId,
      })) ?? run
    );
  },

  async retryStep({ accessScope = {}, runId, stepId } = {}) {
    const existingRun = await this.getRun({
      accessScope,
      runId,
    });

    if (!existingRun) {
      const error = new Error("Agent run not found.");
      error.status = 404;
      throw error;
    }

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

    const run = await this.updateRun({
      allowRetryTransition: true,
      accessScope,
      runId,
      patch: {
        status: AGENT_RUN_STATUSES.running,
        steps: retryResult.steps,
      },
    });

    await this.appendRunEvent({
      accessScope,
      runId,
      type: "step_retry_queued",
      payload: {
        retryOfStepId: retryResult.retryStep.retryOfStepId,
        stepId: retryResult.retryStep.id,
      },
    });

    return (
      (await this.getRun({
        accessScope,
        runId,
      })) ?? run
    );
  },

  async getRun({ accessScope = {}, runId } = {}) {
    const run = await agentRunStore.get?.({
      accessScope,
      runId,
    });

    return run ? stripInternalRunFields(run) : null;
  },

  async listRuns({ accessScope = {}, status = "" } = {}) {
    return {
      runs: toArray(
        await agentRunStore.list?.({
          accessScope,
          status,
        })
      ).map(stripInternalRunFields),
    };
  },

  async listRecoverableRuns({
    statuses = [
      AGENT_RUN_STATUSES.running,
      AGENT_RUN_STATUSES.waitingForUser,
    ],
  } = {}) {
    return {
      runs: toArray(
        await agentRunStore.listRecoverable?.({
          statuses,
        })
      ).map(stripInternalRunFields),
    };
  },
});
