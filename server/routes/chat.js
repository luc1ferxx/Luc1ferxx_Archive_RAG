import { Router } from "express";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";
import { runWithAgentEventSink } from "../rag/agent-event-stream.js";

import { parseDocIds, serializeError } from "./helpers.js";
import { parseOrRespond, requiredTrimmedString } from "./validation.js";

const questionSchema = z.object({
  question: requiredTrimmedString("Question is required."),
});

/**
 * The /chat and /chat/stream request check: the question from the query (GET)
 * or the JSON body. Answers 400 and returns null when it fails. Exported so the
 * public edge of a split deployment (rag/agent-service/edge-router.js) refuses
 * the same requests before forwarding them to the agent tier.
 */
export const validateChatRequest = (req, res) =>
  parseOrRespond(questionSchema, req.method === "GET" ? req.query : req.body, res);

export const createChatRouter = (services) => {
  const router = Router();
  const {
    agentBudget,
    agentRunService,
    arxivImportService,
    buildChatResponse,
    capabilityRegistry,
    dagPlannerAdapter,
    executionPlannerAdapter,
    intentPlannerAdapter,
    ragService,
    replanAdapter,
    skillRegistry,
    unifiedGraphPlannerAdapter,
    webChatService,
  } = services;

  // Shared by /chat and /chat/stream: validation, scope, and the one agent entry
  // point, so the two responses can never disagree about what was answered.
  const parseChatRequest = (req, res) => {
    const payload = req.method === "GET" ? req.query : req.body;
    const parsed = validateChatRequest(req, res);
    if (!parsed) return null;
    const accessScope = getRequestAccessScope(req);

    return {
      accessScope,
      docIds: parseDocIds(payload.docIds, payload.docId),
      question: parsed.question,
      sessionId: payload.sessionId?.trim() || null,
      userId: accessScope.userId || payload.userId?.trim() || null,
    };
  };

  const answer = (request) =>
    buildChatResponse({
      agentBudget,
      agentRunService,
      arxivImportService,
      capabilityRegistry,
      ragService,
      webChatService,
      ...request,
      dagPlannerAdapter,
      executionPlannerAdapter,
      intentPlannerAdapter,
      replanAdapter,
      skillRegistry,
      unifiedGraphPlannerAdapter,
    });

  const handleChatRequest = async (req, res) => {
    const request = parseChatRequest(req, res);
    if (!request) return;

    try {
      const response = await answer(request);

      return res.status(response.status).json(response.body);
    } catch (error) {
      return res.status(error.status ?? 500).json({
        error: serializeError(error, "Failed to answer the question."),
      });
    }
  };

  // Server-sent events: one trace_step event per agent step as it is recorded,
  // then a result event carrying exactly the /chat status and body, then done.
  // A client that disconnects stops receiving events; the run itself finishes,
  // because cancelling it midway could leave a durable agent run half-written.
  const handleChatStreamRequest = async (req, res) => {
    const request = parseChatRequest(req, res);
    if (!request) return;

    res.status(200).set({
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      // Stops reverse proxies such as nginx from buffering the stream.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    let open = true;
    // The response's close, not the request's: current Node emits close on the
    // request as soon as its body has been read, so a listener there either
    // never fires or fires before the run starts, depending on how many async
    // hops the middleware took. The response closes when the client goes away
    // (or once it has ended).
    res.on("close", () => {
      open = false;
    });
    const send = (event, data) => {
      if (open) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };
    // A comment line every 15 s keeps idle proxies from closing a slow run.
    const heartbeat = setInterval(() => {
      if (open) res.write(": keep-alive\n\n");
    }, 15000);

    try {
      const response = await runWithAgentEventSink(
        (event) => send(event.type, event),
        () => answer(request)
      );

      send("result", { body: response.body, status: response.status });
    } catch (error) {
      send("error", {
        error: serializeError(error, "Failed to answer the question."),
        status: error.status ?? 500,
      });
    } finally {
      clearInterval(heartbeat);
      send("done", {});
      res.end();
    }
  };

  router.get("/chat", handleChatRequest);
  router.post("/chat", handleChatRequest);
  router.post("/chat/stream", handleChatStreamRequest);

  return router;
};
