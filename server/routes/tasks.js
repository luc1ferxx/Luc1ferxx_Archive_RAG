import { Router } from "express";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";

import {
  buildTriggerDispatchRequest,
  normalizeBooleanQuery,
  parseDocIds,
  resolveScopedUserId,
  serializeError,
} from "./helpers.js";
import { parseOrRespond, requiredTrimmedString } from "./validation.js";

const taskIdSchema = z.object({
  taskId: requiredTrimmedString("taskId is required."),
});

const taskActionSchema = z.object({
  taskId: requiredTrimmedString("taskId is required."),
  action: requiredTrimmedString("action is required."),
});

const triggerIdSchema = z.object({
  triggerId: requiredTrimmedString("triggerId is required."),
});

const runIdSchema = z.object({
  runId: requiredTrimmedString("runId is required."),
});

const runActionSchema = z.object({
  runId: requiredTrimmedString("runId is required."),
  action: requiredTrimmedString("action is required."),
});

const runStepRetrySchema = z.object({
  runId: requiredTrimmedString("runId is required."),
  stepId: requiredTrimmedString("stepId is required."),
});

const agentTaskBodySchema = z.object({
  question: requiredTrimmedString("Question is required."),
});

export const createTasksRouter = (services) => {
  const router = Router();
  const {
    agentRunRecoveryActionService,
    agentRunService,
    agentRunStepExecutor,
    agentTaskService,
    agentTriggerDispatcher,
    agentTriggerRegistry,
    capabilityRegistry,
    jobOrchestrator,
    taskService,
  } = services;

  router.get("/tasks", async (req, res) => {
    try {
      return res.json(
        await taskService.listTasks({
          accessScope: getRequestAccessScope(req),
          type: req.query.type,
        })
      );
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to list tasks."),
      });
    }
  });

  router.get("/tasks/:taskId", async (req, res) => {
    const parsed = parseOrRespond(taskIdSchema, req.params, res);
    if (!parsed) return;
    const { taskId } = parsed;

    try {
      const task = await taskService.getTask({
        accessScope: getRequestAccessScope(req),
        taskId,
      });

      if (!task) {
        return res.status(404).json({
          error: "Task not found.",
        });
      }

      return res.json(task);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to read task."),
      });
    }
  });

  router.post("/tasks/:taskId/actions/:action", async (req, res) => {
    const parsed = parseOrRespond(taskActionSchema, req.params, res);
    if (!parsed) return;
    const { taskId, action } = parsed;

    try {
      const task = await jobOrchestrator.resumeTask({
        accessScope: getRequestAccessScope(req),
        action,
        payload: req.body,
        taskId,
      });

      return res.status(202).json({
        task,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to update task."),
      });
    }
  });

  router.post("/agent-tasks", async (req, res) => {
    const payload = req.body ?? {};
    const parsed = parseOrRespond(agentTaskBodySchema, payload, res);
    if (!parsed) return;
    const { question } = parsed;

    try {
      const task = await agentTaskService.createTask({
        accessScope: getRequestAccessScope(req),
        docIds: parseDocIds(payload.docIds, payload.docId),
        maxIterations: payload.maxIterations,
        question,
        sessionId: payload.sessionId?.trim() || null,
        userPreferences: payload.userPreferences,
        userId: resolveScopedUserId(req, payload.userId),
      });

      return res.status(202).json({
        task,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to create agent task."),
      });
    }
  });

  router.get("/agent-triggers", async (req, res) => {
    try {
      return res.json({
        triggers: agentTriggerRegistry.listPublic({
          enabledOnly: normalizeBooleanQuery(req.query.enabledOnly),
        }),
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to list agent triggers."),
      });
    }
  });

  router.post("/agent-triggers/:triggerId/dispatch", async (req, res) => {
    const parsed = parseOrRespond(triggerIdSchema, req.params, res);
    if (!parsed) return;
    const { triggerId } = parsed;

    try {
      const result = await agentTriggerDispatcher.dispatch({
        accessScope: getRequestAccessScope(req),
        triggerId,
        ...buildTriggerDispatchRequest(req),
      });

      return res.status(202).json(result);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to dispatch agent trigger."),
      });
    }
  });

  router.get("/agent-runs", async (req, res) => {
    try {
      return res.json(
        await agentRunService.listRuns({
          accessScope: getRequestAccessScope(req),
          status: req.query.status,
        })
      );
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to list agent runs."),
      });
    }
  });

  router.get("/agent-runs/recovery", async (req, res) => {
    try {
      return res.json(
        await agentRunRecoveryActionService.listRecoveryRuns({
          accessScope: getRequestAccessScope(req),
        })
      );
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to list recoverable agent runs."),
      });
    }
  });

  router.get("/agent-runs/:runId", async (req, res) => {
    const parsed = parseOrRespond(runIdSchema, req.params, res);
    if (!parsed) return;
    const { runId } = parsed;

    try {
      const run = await agentRunService.getRun({
        accessScope: getRequestAccessScope(req),
        runId,
      });

      if (!run) {
        return res.status(404).json({
          error: "Agent run not found.",
        });
      }

      return res.json(run);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to read agent run."),
      });
    }
  });

  router.post(
    "/agent-runs/:runId/recovery/actions/:action",
    async (req, res) => {
      const parsed = parseOrRespond(runActionSchema, req.params, res);
      if (!parsed) return;
      const { runId, action } = parsed;

      try {
        const result = await agentRunRecoveryActionService.applyRecoveryAction({
          accessScope: getRequestAccessScope(req),
          action,
          payload: req.body,
          runId,
        });

        return res.json(result);
      } catch (error) {
        return res.status(error.status ?? 500).json({
          error: serializeError(error, "Failed to recover agent run."),
        });
      }
    }
  );

  router.post("/agent-runs/:runId/actions/:action", async (req, res) => {
    const parsed = parseOrRespond(runActionSchema, req.params, res);
    if (!parsed) return;
    const { runId, action } = parsed;

    try {
      const result = await agentRunStepExecutor.applyApprovalAction({
        accessScope: getRequestAccessScope(req),
        action,
        gateId: req.body.gateId,
        payload: req.body,
        runId,
      });

      return res.json(result);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to update agent run."),
      });
    }
  });

  router.post("/agent-runs/:runId/steps/:stepId/actions/retry", async (req, res) => {
    const parsed = parseOrRespond(runStepRetrySchema, req.params, res);
    if (!parsed) return;
    const { runId, stepId } = parsed;

    try {
      const result = await agentRunStepExecutor.retryStep({
        accessScope: getRequestAccessScope(req),
        runId,
        stepId,
      });

      return res.json(result);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to retry agent run step."),
      });
    }
  });

  router.get("/capabilities", (req, res) =>
    res.json({
      capabilities: capabilityRegistry.list?.() ?? [],
    })
  );

  return router;
};
