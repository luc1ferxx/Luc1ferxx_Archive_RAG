import { randomUUID } from "node:crypto";
import {
  buildTaskScopeKey,
  normalizeTaskAccessScope,
} from "./tasks.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

export const AGENT_RUN_STATUSES = Object.freeze({
  completed: "completed",
  failed: "failed",
  running: "running",
  waitingForUser: "waiting_for_user",
});

const VALID_AGENT_RUN_STATUSES = new Set(Object.values(AGENT_RUN_STATUSES));

const normalizeAgentRunStatus = (status) => {
  const normalizedStatus = normalizeText(status);

  return VALID_AGENT_RUN_STATUSES.has(normalizedStatus)
    ? normalizedStatus
    : AGENT_RUN_STATUSES.running;
};

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
    steps: toArray(run.steps),
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
    const run = await agentRunStore.create({
      accessScope,
      run: {
        runId,
        status,
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

  async updateRun({ accessScope = {}, runId, patch = {} } = {}) {
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
    steps = [],
  } = {}) {
    const run = await this.updateRun({
      accessScope,
      runId,
      patch: {
        approvalGates,
        decisions,
        observations,
        result,
        status,
        steps,
      },
    });

    await this.appendRunEvent({
      accessScope,
      runId,
      type: status === AGENT_RUN_STATUSES.failed ? "run_failed" : "run_completed",
      payload: {
        status,
      },
    });

    return run;
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

    return run;
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
