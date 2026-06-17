import { AGENT_RUN_STATUSES } from "./agent-runs.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const MANUAL_RECOVERY_EVENT = "manual_recovery_required";

const hasManualRecoveryEvent = (run = {}) =>
  toArray(run.events).some((event) => event.type === MANUAL_RECOVERY_EVENT);

const buildRecoveryPatch = ({
  mode,
  now,
  reason,
  run,
} = {}) => ({
  result: {
    recovery: {
      mode,
      originalStatus: run.status,
      reason,
      recoveredAt: now(),
    },
  },
  status:
    run.status === AGENT_RUN_STATUSES.running
      ? AGENT_RUN_STATUSES.waitingForUser
      : run.status,
});

export const createAgentRunRecoveryService = ({
  agentRunService,
  now = () => new Date().toISOString(),
} = {}) => ({
  async recoverOnStartup({
    mode = "manual",
    reason = "server_startup_recovery",
    statuses = [
      AGENT_RUN_STATUSES.running,
      AGENT_RUN_STATUSES.waitingForUser,
    ],
  } = {}) {
    if (!agentRunService?.listRecoverableRuns) {
      return {
        mode,
        recoveredCount: 0,
        skippedCount: 0,
        runs: [],
      };
    }

    const recoverableRuns = await agentRunService.listRecoverableRuns({
      includeAccessScope: true,
      statuses,
    });
    const recovered = [];
    let skippedCount = 0;

    for (const run of recoverableRuns.runs ?? []) {
      if (hasManualRecoveryEvent(run)) {
        skippedCount += 1;
        continue;
      }

      const accessScope = run.accessScope ?? {};
      const recoveryPatch = buildRecoveryPatch({
        mode,
        now,
        reason,
        run,
      });
      const updatedRun = await agentRunService.updateRun({
        accessScope,
        runId: run.runId,
        patch: recoveryPatch,
      });

      await agentRunService.appendRunEvent?.({
        accessScope,
        runId: run.runId,
        type: MANUAL_RECOVERY_EVENT,
        payload: {
          mode,
          originalStatus: run.status,
          reason,
          status: updatedRun?.status ?? recoveryPatch.status,
        },
      });

      recovered.push(
        (await agentRunService.getRun?.({
          accessScope,
          runId: run.runId,
        })) ?? updatedRun
      );
    }

    return {
      mode: normalizeText(mode) || "manual",
      recoveredCount: recovered.length,
      skippedCount,
      runs: recovered,
    };
  },
});
