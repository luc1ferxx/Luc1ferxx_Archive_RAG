import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_ACTION_IDS,
  createAdminActionRegistry,
} from "../rag/admin-actions.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

test("admin recover-tasks action calls the existing job recovery runner", async () => {
  const calls = [];
  const registry = createAdminActionRegistry({
    jobOrchestrator: {
      recoverRunnableTasks: async (...args) => {
        calls.push(args);

        return {
          scheduledCount: 2,
          tasks: [
            {
              payload: {
                secret: "sk-secret-task",
              },
            },
          ],
        };
      },
    },
  });

  const result = await registry.runAction({
    accessScope,
    actionId: ADMIN_ACTION_IDS.recoverTasks,
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.status, "completed");
  assert.equal(result.action.id, ADMIN_ACTION_IDS.recoverTasks);
  assert.deepEqual(result.result, {
    scheduledCount: 2,
  });
  assert.deepEqual(calls, [[]]);
  assert.doesNotMatch(serialized, /sk-secret-task/);
});

test("admin recovery-scan action returns compact recovery state only", async () => {
  const calls = [];
  const registry = createAdminActionRegistry({
    agentRunRecoveryActionService: {
      listRecoveryRuns: async ({ accessScope: scopedAccess }) => {
        calls.push(scopedAccess);

        return {
          runs: [
            {
              input: {
                prompt: "private run prompt",
              },
              recovery: {
                actions: [
                  {
                    label: "Resume document RAG",
                    reason: "safe_step_ready",
                    safety: {
                      canAutoReplay: true,
                      reasonCodes: [],
                      steps: [
                        {
                          input: {
                            question: "private step question",
                          },
                        },
                      ],
                    },
                    stepId: "step-1",
                    stepType: "document_rag",
                    type: "resume_from_step",
                  },
                  {
                    label: "Cancel run",
                    reason: "manual_recovery",
                    type: "cancel",
                  },
                ],
                reason: "safe_step_ready",
                replaySafety: {
                  canAutoReplay: true,
                  reasonCodes: ["requires_approval"],
                  steps: [
                    {
                      input: {
                        question: "private replay question",
                      },
                    },
                  ],
                },
                required: true,
                stepId: "step-1",
              },
              runId: "run-1",
              status: "waiting_for_user",
              steps: [
                {
                  input: {
                    question: "private persisted step input",
                  },
                },
              ],
              updatedAt: "2026-07-02T00:00:00.000Z",
            },
          ],
        };
      },
    },
  });

  const result = await registry.runAction({
    accessScope,
    actionId: ADMIN_ACTION_IDS.recoveryScan,
  });
  const serialized = JSON.stringify(result);

  assert.deepEqual(calls, [accessScope]);
  assert.equal(result.result.total, 1);
  assert.equal(result.result.actionCount, 2);
  assert.deepEqual(result.result.actionsByType, {
    cancel: 1,
    resume_from_step: 1,
  });
  assert.equal(result.result.runs[0].runId, "run-1");
  assert.equal(result.result.runs[0].recovery.replaySafety.stepCount, 1);
  assert.doesNotMatch(serialized, /private run prompt/);
  assert.doesNotMatch(serialized, /private step question/);
  assert.doesNotMatch(serialized, /private replay question/);
  assert.doesNotMatch(serialized, /private persisted step input/);
});

test("admin quality-refresh action uses the existing quality runner and compacts the report", async () => {
  const calls = [];
  const registry = createAdminActionRegistry({
    qualityService: {
      runSyntheticQualityEvaluation: async ({ corpusPath }) => {
        calls.push(corpusPath);

        return {
          failedCases: [
            {
              answer: "private answer should not leak",
              question: "private question should not leak",
            },
          ],
          status: "fail",
          summary: {
            corpus: {
              cases: 3,
              path: corpusPath,
            },
            createdAt: "2026-07-02T00:00:00.000Z",
            metrics: {
              overallPassPercent: 66.7,
              overallPassRate: 0.667,
              qaPageHitPercent: 50,
            },
            runId: "quality-refresh-run",
          },
        };
      },
    },
  });

  const result = await registry.runAction({
    actionId: ADMIN_ACTION_IDS.qualityRefresh,
    payload: {
      corpusPath: " evaluation/synthetic-corpus-compare-hard.json ",
    },
  });
  const serialized = JSON.stringify(result);

  assert.deepEqual(calls, ["evaluation/synthetic-corpus-compare-hard.json"]);
  assert.equal(result.result.quality.status, "fail");
  assert.equal(result.result.quality.runId, "quality-refresh-run");
  assert.equal(result.result.quality.failedCaseCount, 1);
  assert.equal(result.result.quality.corpus.cases, 3);
  assert.equal(result.result.quality.metrics.overallPassPercent, 66.7);
  assert.doesNotMatch(serialized, /private answer/);
  assert.doesNotMatch(serialized, /private question/);
});

test("admin actions expose unknown and unavailable actions as controlled errors", async () => {
  const registry = createAdminActionRegistry();

  await assert.rejects(
    () =>
      registry.runAction({
        actionId: "unknown-action",
      }),
    {
      expose: true,
      message: "Admin action not found.",
      status: 404,
    }
  );

  await assert.rejects(
    () =>
      registry.runAction({
        actionId: ADMIN_ACTION_IDS.recoverTasks,
      }),
    {
      expose: true,
      message: "Recover tasks admin action is unavailable.",
      status: 503,
    }
  );
});
