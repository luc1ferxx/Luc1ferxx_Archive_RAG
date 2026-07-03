import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_STATUS_VALUES,
  createAdminStatusService,
} from "../rag/admin-status.js";
import { AGENT_RUN_STATUSES } from "../rag/agent-runs.js";
import { TASK_STATUSES } from "../rag/tasks.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

const createConfig = (overrides = {}) => ({
  getAgentRunRecoveryMode: () => "manual",
  getAgentRunStoreProvider: () => "postgres",
  getTaskStoreProvider: () => "postgres",
  getVectorStoreProvider: () => "local",
  isApiAuthEnabled: () => true,
  isStartupHealthStrict: () => true,
  ...overrides,
});

test("admin status aggregates compact deployment health quality and runtime counts", async () => {
  const calls = [];
  const service = createAdminStatusService({
    agentRunRecoveryActionService: {
      listRecoveryRuns: async ({ accessScope: scopedAccess }) => {
        calls.push(["recovery", scopedAccess]);

        return {
          runs: [
            {
              recovery: {
                actions: [
                  {
                    type: "resume_from_step",
                  },
                ],
                required: true,
              },
              result: {
                recovery: {
                  mode: "manual",
                  rawPrompt: "raw prompt should not leak",
                },
              },
              runId: "run-recovery",
              status: AGENT_RUN_STATUSES.waitingForUser,
            },
          ],
        };
      },
    },
    agentRunService: {
      listRuns: async ({ accessScope: scopedAccess, status }) => {
        calls.push(["runs", status, scopedAccess]);

        if (status === AGENT_RUN_STATUSES.failed) {
          return {
            runs: [
              {
                error: {
                  message: "sk-secret-run-error",
                },
                input: {
                  prompt: "private run prompt",
                },
                runId: "run-failed",
                status,
              },
            ],
          };
        }

        if (status === AGENT_RUN_STATUSES.waitingForUser) {
          return {
            runs: [
              {
                runId: "run-waiting",
                status,
              },
            ],
          };
        }

        return {
          runs: [],
        };
      },
    },
    config: createConfig({
      isApiAuthEnabled: () => false,
      isStartupHealthStrict: () => false,
    }),
    healthService: {
      buildHealthReport: async () => ({
        checkedAt: "2026-07-02T00:00:00.000Z",
        checks: {
          apiAuth: {
            message: "Auth disabled with sk-secret-auth",
            status: "disabled",
          },
          openai: {
            chatModel: "gpt-test",
            message: "OPENAI_API_KEY missing sk-secret-openai",
            status: "error",
          },
          taskStore: {
            backend: "postgresql",
            message: "Task table reachable",
            table: "private_task_table",
            status: "ok",
          },
        },
        status: "error",
      }),
    },
    now: () => "2026-07-02T00:00:01.000Z",
    processEnv: {
      NODE_ENV: "production",
    },
    processVersion: "v20.0.0",
    qualityService: {
      readLatestQualityReport: async () => ({
        failedCases: [
          {
            answer: "secret answer should not leak",
            question: "private quality question",
          },
        ],
        status: "fail",
        summary: {
          corpus: {
            cases: 2,
            path: "evaluation/synthetic-corpus-hard.json",
          },
          createdAt: "2026-07-01T00:00:00.000Z",
          metrics: {
            overallPassPercent: 50,
            overallPassRate: 0.5,
            qaPageHitPercent: 40,
          },
          runId: "quality-run",
        },
      }),
    },
    taskService: {
      listTasks: async ({ accessScope: scopedAccess }) => {
        calls.push(["tasks", scopedAccess]);

        return {
          tasks: [
            {
              id: "task-queued",
              payload: {
                secret: "sk-secret-task",
              },
              status: TASK_STATUSES.queued,
            },
            {
              id: "task-failed",
              result: {
                answer: "private task result",
              },
              status: TASK_STATUSES.failed,
            },
            {
              id: "task-waiting",
              status: TASK_STATUSES.waitingForUser,
            },
          ],
        };
      },
    },
    triggerRegistry: {
      listPublic: () => [
        {
          enabled: true,
          id: "trigger-enabled",
        },
        {
          enabled: false,
          id: "trigger-disabled",
        },
      ],
    },
  });

  const status = await service.buildStatus({
    accessScope,
  });
  const serialized = JSON.stringify(status);

  assert.equal(status.status, "error");
  assert.deepEqual(status.deployment, {
    agentRunRecoveryMode: "manual",
    agentRunStoreProvider: "postgres",
    apiAuthEnabled: false,
    environment: "production",
    nodeVersion: "v20.0.0",
    runtime: "node",
    startupHealthStrict: false,
    taskStoreProvider: "postgres",
    vectorStoreProvider: "local",
  });
  assert.equal(status.health.status, "error");
  assert.equal(status.health.checks.openai.status, "error");
  assert.equal(status.health.checks.openai.message, undefined);
  assert.equal(status.quality.status, "fail");
  assert.equal(status.quality.failedCaseCount, 1);
  assert.equal(status.quality.runId, "quality-run");
  assert.equal(status.tasks.total, 3);
  assert.equal(status.tasks.counts[TASK_STATUSES.failed], 1);
  assert.equal(status.agentRuns.total, 2);
  assert.equal(status.agentRuns.failedCount, 1);
  assert.equal(status.agentRuns.recoveryCount, 1);
  assert.equal(status.agentRuns.manualRecoveryCount, 1);
  assert.equal(status.triggers.enabledCount, 1);
  assert.equal(status.triggers.disabledCount, 1);
  assert.ok(
    status.warnings.some((warning) => warning.id === "api_auth_disabled")
  );
  assert.ok(
    status.warnings.some((warning) => warning.id === "startup_health_not_strict")
  );
  assert.ok(
    status.warnings.some((warning) => warning.id === "health_openai_error")
  );
  assert.ok(status.warnings.some((warning) => warning.id === "quality_fail"));
  assert.ok(status.warnings.some((warning) => warning.id === "tasks_failed"));
  assert.ok(
    status.warnings.some((warning) => warning.id === "agent_runs_failed")
  );
  assert.ok(
    status.warnings.some((warning) => warning.id === "agent_runs_need_recovery")
  );
  assert.doesNotMatch(serialized, /sk-secret/);
  assert.doesNotMatch(serialized, /private run prompt/);
  assert.doesNotMatch(serialized, /private quality question/);
  assert.doesNotMatch(serialized, /secret answer should not leak/);
  assert.doesNotMatch(serialized, /private task result/);
  assert.doesNotMatch(serialized, /private_task_table/);
  assert.deepEqual(calls[0], ["tasks", accessScope]);
});

test("admin status degrades unavailable services without leaking error messages", async () => {
  const service = createAdminStatusService({
    agentRunService: null,
    config: createConfig(),
    healthService: {
      buildHealthReport: async () => {
        throw Object.assign(new Error("health failed with sk-secret-health"), {
          status: 503,
        });
      },
    },
    qualityService: {
      readLatestQualityReport: async () => {
        throw Object.assign(new Error("quality failed with sk-secret-quality"), {
          status: 404,
        });
      },
    },
    taskService: {
      listTasks: async () => {
        throw new Error("task failed with sk-secret-task");
      },
    },
    triggerRegistry: null,
  });

  const status = await service.buildStatus({
    accessScope,
  });
  const serialized = JSON.stringify(status);

  assert.equal(status.status, ADMIN_STATUS_VALUES.warn);
  assert.equal(status.health.status, ADMIN_STATUS_VALUES.unavailable);
  assert.equal(status.health.error.status, 503);
  assert.equal(status.quality.status, ADMIN_STATUS_VALUES.unavailable);
  assert.equal(status.quality.error.status, 404);
  assert.equal(status.tasks.status, ADMIN_STATUS_VALUES.unavailable);
  assert.equal(status.agentRuns.status, ADMIN_STATUS_VALUES.unavailable);
  assert.equal(status.triggers.status, ADMIN_STATUS_VALUES.unavailable);
  assert.ok(
    status.warnings.some((warning) => warning.id === "health_unavailable")
  );
  assert.ok(
    status.warnings.some((warning) => warning.id === "quality_unavailable")
  );
  assert.ok(status.warnings.some((warning) => warning.id === "tasks_unavailable"));
  assert.ok(
    status.warnings.some((warning) => warning.id === "agentRuns_unavailable")
  );
  assert.ok(
    status.warnings.some((warning) => warning.id === "triggers_unavailable")
  );
  assert.doesNotMatch(serialized, /sk-secret/);
});

test("admin status reports ok when dependencies are healthy and no work is blocked", async () => {
  const service = createAdminStatusService({
    agentRunRecoveryActionService: {
      listRecoveryRuns: async () => ({
        runs: [],
      }),
    },
    agentRunService: {
      listRuns: async () => ({
        runs: [],
      }),
    },
    config: createConfig(),
    healthService: {
      buildHealthReport: async () => ({
        checkedAt: "2026-07-02T00:00:00.000Z",
        checks: {
          apiAuth: {
            status: "ok",
          },
          openai: {
            status: "ok",
          },
        },
        status: "ok",
      }),
    },
    qualityService: {
      readLatestQualityReport: async () => ({
        failedCases: [],
        status: "ok",
        summary: {
          metrics: {
            overallPassPercent: 100,
            overallPassRate: 1,
          },
          runId: "quality-ok",
        },
      }),
    },
    taskService: {
      listTasks: async () => ({
        tasks: [],
      }),
    },
    triggerRegistry: {
      listPublic: () => [
        {
          enabled: true,
          id: "research_dossier_manual",
        },
      ],
    },
  });

  const status = await service.buildStatus({
    accessScope,
  });

  assert.equal(status.status, ADMIN_STATUS_VALUES.ok);
  assert.deepEqual(status.warnings, []);
  assert.equal(status.tasks.total, 0);
  assert.equal(status.agentRuns.total, 0);
  assert.equal(status.triggers.enabledCount, 1);
});
