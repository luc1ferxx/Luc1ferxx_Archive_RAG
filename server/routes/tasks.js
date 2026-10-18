import { Router } from "express";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";
import {
  getChatMaxDocIds,
  getChatMaxIdChars,
  getChatMaxQuestionChars,
  getTaskMaxPayloadBytes,
} from "../rag/config.js";
import { TENANT_TASK_LIMITED } from "../rag/job-orchestrator.js";
import { runAgentRequestWithCancellation } from "../rag/request-deadline.js";

import { sendAgentRouteError } from "./chat.js";

import {
  buildTriggerDispatchRequest,
  normalizeBooleanQuery,
  parseDocIds,
  resolveScopedUserId,
  serializeError,
} from "./helpers.js";
import {
  boundedIdList,
  boundedJsonPayload,
  boundedRequiredTrimmedString,
  checkJsonPayloadBounds,
  optionalBoundedKey,
  optionalBoundedString,
  parseOrRespond,
} from "./validation.js";

// The request schemas and validators are exported so the public edge of a
// split deployment (rag/agent-service/edge-router.js) refuses the same
// requests before forwarding them to the agent tier. Every string is bounded
// like /chat's (routes/chat.js): a question by CHAT_MAX_QUESTION_CHARS, an id
// (path parameters, gate, session, user and idempotency ids, list filters) by
// CHAT_MAX_ID_CHARS, an agent task's docIds by CHAT_MAX_DOC_IDS, and every
// free-form JSON the routes persist or hand on by TASK_MAX_PAYLOAD_BYTES and
// MAX_PAYLOAD_DEPTH (validation.js). A request past a bound is answered 400
// with { error }, as /chat answers.

// At most this many preferences per agent task, each at most a question long.
export const MAX_AGENT_TASK_USER_PREFERENCES = 64;

const requiredId = (field) =>
  boundedRequiredTrimmedString(`${field} is required.`, { field, maxLength: getChatMaxIdChars });

const optionalId = (field) => optionalBoundedString(field, { maxLength: getChatMaxIdChars });

export const taskIdSchema = z.object({
  taskId: requiredId("taskId"),
});

export const taskActionSchema = z.object({
  taskId: requiredId("taskId"),
  action: requiredId("action"),
});

export const triggerIdSchema = z.object({
  triggerId: requiredId("triggerId"),
});

export const runIdSchema = z.object({
  runId: requiredId("runId"),
});

export const runActionSchema = z.object({
  runId: requiredId("runId"),
  action: requiredId("action"),
});

export const runStepRetrySchema = z.object({
  runId: requiredId("runId"),
  stepId: requiredId("stepId"),
});

// GET /tasks?type, GET /agent-runs?status, GET /agent-triggers?enabledOnly:
// one short string each (a repeated parameter arrives as an array).
export const taskListQuerySchema = z.object({ type: optionalId("type") });
export const runListQuerySchema = z.object({ status: optionalId("status") });
export const triggerListQuerySchema = z.object({ enabledOnly: optionalId("enabledOnly") });

export const agentTaskBodySchema = z
  .looseObject({
    question: boundedRequiredTrimmedString("Question is required.", {
      field: "Question",
      maxLength: getChatMaxQuestionChars,
    }),
    docIds: boundedIdList("docIds", { maxCount: getChatMaxDocIds, maxLength: getChatMaxIdChars }),
    docId: optionalId("docId"),
    sessionId: optionalId("sessionId"),
    userId: optionalId("userId"),
    userPreferences: z
      .array(optionalBoundedString("Each user preference", { maxLength: getChatMaxQuestionChars }), {
        error: "userPreferences must be a list of strings.",
      })
      .max(MAX_AGENT_TASK_USER_PREFERENCES, {
        error: `At most ${MAX_AGENT_TASK_USER_PREFERENCES} userPreferences.`,
      })
      .nullish(),
  })
  .superRefine((body, context) => {
    // Everything but docIds (bounded above) is stored with the task.
    const { docIds, ...rest } = body;

    checkJsonPayloadBounds(rest, context, { field: "The agent task", maxBytes: getTaskMaxPayloadBytes });
  });

// The JSON body of an action route (POST /tasks/:taskId/actions/:action, the
// agent-run recovery actions and step retry): handed to the service as
// `payload`, or unused.
export const actionBodySchema = boundedJsonPayload("The action payload", { maxBytes: getTaskMaxPayloadBytes });

export const runActionBodySchema = z
  .looseObject({ gateId: optionalId("gateId") })
  .superRefine((body, context) => {
    checkJsonPayloadBounds(body, context, { field: "The action payload", maxBytes: getTaskMaxPayloadBytes });
  });

// POST /agent-triggers/:triggerId/dispatch: the body is the trigger's event,
// input and request (helpers.js buildTriggerDispatchRequest), bounded as one
// payload; its ids, and the idempotency headers it falls back to, as ids.
export const triggerDispatchBodySchema = z
  .looseObject({
    idempotencyKey: optionalBoundedKey("idempotencyKey", { maxLength: getChatMaxIdChars }),
    mode: optionalId("mode"),
  })
  .superRefine((body, context) => {
    // buildTriggerDispatchRequest reads request.id only from an object.
    const request = body.request;

    if (request && typeof request === "object" && !Array.isArray(request)) {
      const parsed = optionalBoundedKey("request.id", { maxLength: getChatMaxIdChars }).safeParse(request.id);

      if (!parsed.success) {
        context.addIssue({ code: "custom", message: parsed.error.issues[0].message });
        return;
      }
    }

    checkJsonPayloadBounds(body, context, { field: "The trigger dispatch", maxBytes: getTaskMaxPayloadBytes });
  });

const IDEMPOTENCY_HEADERS = ["x-idempotency-key", "x-request-id"];

const respondWithIssue = (res, message) => {
  res.status(400).json({ error: message });
  return null;
};

const validateBody = (schema) => (req, res) => parseOrRespond(schema, req.body ?? {}, res);

// Both the parameters and the body (or query) must pass; the parsed
// parameters are returned, as parseOrRespond returns them.
const validateParamsAnd = (paramsSchema, check) => (req, res) => {
  const params = parseOrRespond(paramsSchema, req.params, res);

  return params && check(req, res) ? params : null;
};

export const validateTaskListRequest = (req, res) => parseOrRespond(taskListQuerySchema, req.query, res);
export const validateRunListRequest = (req, res) => parseOrRespond(runListQuerySchema, req.query, res);
export const validateTriggerListRequest = (req, res) => parseOrRespond(triggerListQuerySchema, req.query, res);
export const validateTaskIdRequest = (req, res) => parseOrRespond(taskIdSchema, req.params, res);
export const validateRunIdRequest = (req, res) => parseOrRespond(runIdSchema, req.params, res);
export const validateAgentTaskRequest = validateBody(agentTaskBodySchema);
export const validateTaskActionRequest = validateParamsAnd(taskActionSchema, validateBody(actionBodySchema));
export const validateRunActionRequest = validateParamsAnd(runActionSchema, validateBody(runActionBodySchema));
export const validateRunRecoveryActionRequest = validateParamsAnd(runActionSchema, validateBody(actionBodySchema));
export const validateRunStepRetryRequest = validateParamsAnd(runStepRetrySchema, validateBody(actionBodySchema));
export const validateTriggerDispatchRequest = validateParamsAnd(triggerIdSchema, (req, res) => {
  if (!parseOrRespond(triggerDispatchBodySchema, req.body ?? {}, res)) {
    return null;
  }

  const maximum = getChatMaxIdChars();

  for (const header of IDEMPOTENCY_HEADERS) {
    if (String(req.get(header) ?? "").trim().length > maximum) {
      return respondWithIssue(res, `${header} must be at most ${maximum} characters.`);
    }
  }

  return true;
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
    if (!validateTaskListRequest(req, res)) return;

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
    const parsed = validateTaskIdRequest(req, res);
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
    const parsed = validateTaskActionRequest(req, res);
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
    const parsed = validateAgentTaskRequest(req, res);
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
        // TENANT_MAX_QUEUED_TASKS (rag/agent-tasks.js): the stable code.
        ...(error?.code === TENANT_TASK_LIMITED ? { code: error.code } : {}),
        error: serializeError(error, "Failed to create agent task."),
      });
    }
  });

  router.get("/agent-triggers", async (req, res) => {
    if (!validateTriggerListRequest(req, res)) return;

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
    const parsed = validateTriggerDispatchRequest(req, res);
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
    if (!validateRunListRequest(req, res)) return;

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
    const parsed = validateRunIdRequest(req, res);
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
      const parsed = validateRunRecoveryActionRequest(req, res);
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
    const parsed = validateRunActionRequest(req, res);
    if (!parsed) return;
    const { runId, action } = parsed;

    try {
      // An approval may continue the run's graph: it runs under the request's
      // deadline and disconnect cancellation, as /chat does (routes/chat.js).
      const result = await runAgentRequestWithCancellation(req, res, () =>
        agentRunStepExecutor.applyApprovalAction({
          accessScope: getRequestAccessScope(req),
          action,
          gateId: req.body.gateId,
          payload: req.body,
          runId,
        })
      );

      return res.json(result);
    } catch (error) {
      return sendAgentRouteError(res, error, "Failed to update agent run.");
    }
  });

  router.post("/agent-runs/:runId/steps/:stepId/actions/retry", async (req, res) => {
    const parsed = validateRunStepRetryRequest(req, res);
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
