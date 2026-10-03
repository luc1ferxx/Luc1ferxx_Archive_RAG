import { randomUUID } from "node:crypto";

import express from "express";

import { bindDatabaseTenant } from "../../auth.js";
import { ADMIN_PERMISSION_IDS, buildAdminAccessDecision } from "../admin-permissions.js";
import {
  getModelGatewayChatUpstreams,
  getModelGatewayEmbeddingUpstreams,
  getModelGatewayRerankUpstreams,
  getSharedStateProvider,
} from "../config.js";
import { getModelCallGuardTotals } from "../model-call-guard.js";
import { recordGatewayQuotaRejection } from "../metrics-model.js";
import {
  MODEL_CAPABILITIES,
  MODEL_ROUTE_IDS,
  resolveModelRouteForRuntime,
} from "../model-providers/index.js";
import { completeTextWithMetadata, embedQuery, embedTexts } from "../openai.js";
import {
  configureModelUpstreamPools,
  createRawChatPrompt,
  resetModelUpstreamPools,
} from "../openai-client.js";
import { toDatabaseTenant } from "../postgres-tenant.js";
import { scoreTextsWithCrossEncoderBackend } from "../reranker.js";
import { bindServiceTraceContext } from "../service-client.js";
import {
  getServiceDeadlineRemainingMs,
  getServiceKeyStatus,
  handleServiceRequestBodyError,
  requireServiceIdentity,
  verifyServiceRequestBody,
} from "../service-identity.js";
import { SERVICE_TIERS } from "../service-topology.js";
import { runWithModelGatewayCall } from "./call-context.js";
import {
  buildModelGatewayErrorBody,
  buildRetryAfterHeaders,
  describeModelGatewayError,
  MODEL_GATEWAY_ERROR_CODES,
  MODEL_GATEWAY_EXTENSION_FIELD,
  MODEL_GATEWAY_METERED_ANNOTATION,
  MODEL_GATEWAY_PATHS,
  pickMeteredUsage,
} from "./protocol.js";
import { createModelGatewayQuotas } from "./quotas.js";
import { createUpstreamPool, parseUpstreamUrls } from "./upstream-pool.js";
import { createModelUsageLedger } from "./usage-ledger.js";

// The model gateway (ARCHIVE_RAG_ROLE=model-gateway, `node model-gateway.mjs`):
// an OpenAI-compatible HTTP service in front of the chat, embedding and rerank
// backends, so model access scales and is governed in one place.
//
//   POST /v1/chat/completions  OpenAI chat completions, JSON or SSE (`stream`)
//   POST /v1/embeddings        OpenAI embeddings; texts are embedded as given
//   POST /rerank               { query, texts, model? } -> { scores }
//   GET  /usage                per-tenant totals since start (system identity,
//                              an `admin` claim, or admin.status.read)
//   GET  /health               replicas, guard state, quota configuration
//
// Every route but /health accepts only a signed internal identity for the
// `model-gateway` audience (service-identity.js); the tenant comes from that
// token, never from a body. A request runs the same code as a monolith model
// call -- openai.js with its retry, backoff, Retry-After, timeout, empty-
// completion retry and registry failover, model-call-guard.js with its
// concurrency cap and breaker -- so this process is simply where they run.
// What the gateway adds: upstream replica pools (upstream-pool.js), per-
// workspace quotas (quotas.js), and a usage ledger fed by the metered LLMOps
// events (usage-ledger.js, call-context.js).
//
// Never logged or returned: prompts, model output (other than to the caller),
// upstream error text, tokens.

const MAX_BODY_BYTES = "32mb";
const MAX_EMBEDDING_INPUTS = 8192;
const MAX_RERANK_TEXTS = 4096;
const VALID_CAPABILITIES = new Set(Object.values(MODEL_CAPABILITIES));

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readExtension = (body) =>
  isPlainObject(body?.[MODEL_GATEWAY_EXTENSION_FIELD]) ? body[MODEL_GATEWAY_EXTENSION_FIELD] : {};

const badRequest = (detailCode = MODEL_GATEWAY_ERROR_CODES.badRequest) => {
  const error = new Error("Bad model gateway request.");

  error.gatewayError = { code: detailCode, status: 400 };
  return error;
};

const sendError = (res, described) => {
  if (res.headersSent) {
    res.end();
    return;
  }

  res
    .status(described.status)
    .set(buildRetryAfterHeaders(described.retryAfterMs))
    .json(buildModelGatewayErrorBody(described));
};

/** Replica pools for the three backends, from the MODEL_GATEWAY_*_UPSTREAMS lists. */
export const createModelGatewayUpstreams = ({ now } = {}) => ({
  chat: createUpstreamPool({
    kind: "chat",
    now,
    urls: parseUpstreamUrls(getModelGatewayChatUpstreams(), {
      variable: "MODEL_GATEWAY_CHAT_UPSTREAMS",
    }),
  }),
  embedding: createUpstreamPool({
    kind: "embedding",
    now,
    urls: parseUpstreamUrls(getModelGatewayEmbeddingUpstreams(), {
      variable: "MODEL_GATEWAY_EMBEDDING_UPSTREAMS",
    }),
  }),
  rerank: createUpstreamPool({
    kind: "rerank",
    now,
    urls: parseUpstreamUrls(getModelGatewayRerankUpstreams(), {
      variable: "MODEL_GATEWAY_RERANK_UPSTREAMS",
    }),
  }),
});

// The tenant a request acts for, from its verified token; null for a system call.
const readTenant = (req) =>
  req.serviceIdentity?.system ? null : toDatabaseTenant(req.accessScope);

// Fires when the caller goes away or the deadline it sent passes, so the
// retries stop and the upstream request is cancelled.
const watchCaller = (req, res) => {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      const reason = new Error("The model call was abandoned: its caller left or its deadline passed.");

      reason.name = "AbortError";
      reason.code = MODEL_GATEWAY_ERROR_CODES.aborted;
      controller.abort(reason);
    }
  };
  const onClose = () => {
    if (!res.writableFinished) {
      abort();
    }
  };
  const remainingMs = getServiceDeadlineRemainingMs(req);
  const timer = remainingMs === null ? null : setTimeout(abort, remainingMs);

  timer?.unref?.();
  res.on("close", onClose);

  return {
    dispose: () => {
      clearTimeout(timer);
      res.off("close", onClose);
    },
    signal: controller.signal,
  };
};

const toOpenAIUsage = (event) => ({
  completion_tokens: event?.outputTokens ?? 0,
  prompt_tokens: event?.inputTokens ?? 0,
  total_tokens: event?.totalTokens ?? 0,
});

// SSE for a streamed completion. Headers go out with the first token (or the
// end of the call), so a call that fails before any token still answers with
// its real status. Attempt markers written before that wait with them.
const createChatEventStream = (res, { created, id }) => {
  let started = false;
  let attempts = 0;
  const pending = [];
  const writable = () => !res.destroyed && !res.writableEnded;
  const frame = (payload) =>
    `data: ${JSON.stringify({ created, id, object: "chat.completion.chunk", ...payload })}\n\n`;
  const start = () => {
    if (started) {
      return;
    }

    started = true;
    res.status(200).set({
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    pending.splice(0).forEach((line) => res.write(line));
  };
  const write = (line) => {
    if (!writable()) {
      return;
    }

    if (started) {
      res.write(line);
    } else {
      pending.push(line);
    }
  };

  return {
    attempt() {
      attempts += 1;
      write(frame({ choices: [], [MODEL_GATEWAY_EXTENSION_FIELD]: { attempt: attempts } }));
    },
    delta(content) {
      if (!writable()) {
        return;
      }

      start();
      write(frame({ choices: [{ delta: { content }, finish_reason: null, index: 0 }] }));
    },
    fail(described) {
      if (!started) {
        sendError(res, described);
        return;
      }

      if (writable()) {
        res.write(`data: ${JSON.stringify(buildModelGatewayErrorBody(described))}\n\n`);
        res.end();
      }
    },
    finish({ extension, finishReason, model, usage }) {
      if (!writable()) {
        return;
      }

      start();
      write(frame({ choices: [{ delta: {}, finish_reason: finishReason, index: 0 }], model }));
      write(frame({ choices: [], model, usage, [MODEL_GATEWAY_EXTENSION_FIELD]: extension }));
      write("data: [DONE]\n\n");
      res.end();
    },
  };
};

/**
 * Builds the gateway's Express app. `quotas`, `ledger` and `upstreams` are
 * injectable for tests; by default they come from the environment. Creating
 * the app points this process's chat and embedding clients at its upstream
 * pools (process-wide: one gateway app per process); `app.locals.modelGateway
 * .close()` undoes that.
 */
export const createModelGatewayApp = ({
  env = process.env,
  issuers,
  ledger = createModelUsageLedger(),
  now = Date.now,
  quotas = createModelGatewayQuotas(),
  upstreams = createModelGatewayUpstreams(),
} = {}) => {
  configureModelUpstreamPools({ chat: upstreams.chat, embedding: upstreams.embedding });

  const app = express();
  const requireIdentity = requireServiceIdentity({
    allowSystem: true,
    audience: SERVICE_TIERS.modelGateway,
    env,
    issuers,
  });
  // The body is parsed after the identity check (nothing is read for a caller
  // that is not a tier) and before the tenant is bound: the parser resumes the
  // chain from a stream callback, which would lose the tenant context. The
  // parser also checks the body against the token's binding.
  const internal = [
    requireIdentity,
    express.json({ limit: MAX_BODY_BYTES, verify: verifyServiceRequestBody }),
    handleServiceRequestBodyError,
    bindDatabaseTenant,
    bindServiceTraceContext,
  ];

  app.disable("x-powered-by");

  const createCall = (tenant) => {
    const call = {
      completion: null,
      events: [],
      // Every LLMOps event recorded while serving this request: tagged as the
      // authoritative (metered) event with its tenant, counted in the ledger,
      // and its tokens charged to the tenant's quota when the call answered.
      meter(event) {
        const metered = {
          ...event,
          annotations: [...(event.annotations ?? []), { ...MODEL_GATEWAY_METERED_ANNOTATION }],
          tenant: tenant ? { ...tenant } : null,
        };

        call.events.push(metered);
        ledger.recordEvent(tenant, metered);

        if (metered.status === "ok") {
          void quotas.chargeTokens(tenant, metered.totalTokens);
        }

        return metered;
      },
      noteCompletion(completion) {
        call.completion = completion;
      },
    };

    return call;
  };

  const answeredEvent = (call) =>
    [...call.events].reverse().find((event) => event.status === "ok") ?? null;

  const buildAnswerExtension = (call, modelRoute) => {
    const answered = answeredEvent(call);

    return {
      latencySloMs: answered?.latencySloMs ?? null,
      modelCalls: call.events.length,
      modelRoute: modelRoute ?? answered?.modelRoute ?? null,
      usage: answered ? pickMeteredUsage(answered) : null,
    };
  };

  // Quota admission, then `work({ call, signal })` inside the call context.
  // Errors become the gateway's error answer; `onError` lets a stream answer
  // on its own channel.
  const serve = (work) => async (req, res) => {
    const tenant = readTenant(req);
    let watcher = null;

    try {
      const admission = await quotas.admit(tenant);

      ledger.recordRequest(tenant, { rejectedBy: admission.ok ? null : admission.quota });

      if (!admission.ok) {
        recordGatewayQuotaRejection(admission.quota);
        sendError(res, {
          code: MODEL_GATEWAY_ERROR_CODES.quotaExceeded,
          message: "The workspace has used its model quota for now.",
          quota: admission.quota,
          retryAfterMs: admission.retryAfterMs,
          status: 429,
          upstreamStatus: null,
        });
        return;
      }

      watcher = watchCaller(req, res);
      const call = createCall(tenant);

      await runWithModelGatewayCall(call, () =>
        work({ body: req.body ?? {}, call, res, signal: watcher.signal })
      );
    } catch (error) {
      const described = describeModelGatewayError(error);

      if (described.status >= 500 && described.code === MODEL_GATEWAY_ERROR_CODES.internal) {
        // Name and code only: a message can carry what the request carried.
        console.error(
          `[model-gateway] ${req.path} failed: ${error?.name ?? "Error"}${error?.code ? ` (${error.code})` : ""}.`
        );
      }

      sendError(res, described);
    } finally {
      watcher?.dispose();
    }
  };

  const readChatOptions = (body, signal) => {
    const extension = readExtension(body);
    const capability = extension.capability ?? MODEL_CAPABILITIES.chat;

    if (!Array.isArray(body.messages) || body.messages.length === 0 || !VALID_CAPABILITIES.has(capability)) {
      throw badRequest();
    }

    const routeId = typeof extension.routeId === "string" ? extension.routeId.trim() : "";

    return {
      capability,
      promptTemplate: extension.promptTemplate ?? undefined,
      responseFormat: isPlainObject(body.response_format) ? body.response_format : null,
      ...(typeof body.temperature === "number" && Number.isFinite(body.temperature) && body.temperature >= 0 && body.temperature <= 2
        ? { temperature: body.temperature }
        : {}),
      ...(routeId ? { routeId } : {}),
      signal,
      ...(isPlainObject(extension.workspacePolicy) ? { workspacePolicy: extension.workspacePolicy } : {}),
    };
  };

  app.post(
    MODEL_GATEWAY_PATHS.chatCompletions,
    ...internal,
    serve(async ({ body, call, res, signal }) => {
      const options = readChatOptions(body, signal);
      const prompt = createRawChatPrompt(body.messages);
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(now() / 1000);

      if (body.stream !== true) {
        const result = await completeTextWithMetadata(prompt, options);
        const answered = answeredEvent(call);

        res.json({
          choices: [
            {
              finish_reason: call.completion?.finishReason ?? "stop",
              index: 0,
              message: { content: result.text, role: "assistant" },
            },
          ],
          created,
          id,
          model: call.completion?.modelName ?? null,
          object: "chat.completion",
          usage: toOpenAIUsage(answered),
          [MODEL_GATEWAY_EXTENSION_FIELD]: buildAnswerExtension(call, result.modelRoute),
        });
        return;
      }

      const events = createChatEventStream(res, { created, id });

      try {
        const result = await completeTextWithMetadata(prompt, {
          ...options,
          onAttemptStart: () => events.attempt(),
          onTextDelta: (delta) => events.delta(delta),
        });

        events.finish({
          extension: buildAnswerExtension(call, result.modelRoute),
          finishReason: call.completion?.finishReason ?? "stop",
          model: call.completion?.modelName ?? null,
          usage: toOpenAIUsage(answeredEvent(call)),
        });
      } catch (error) {
        events.fail(describeModelGatewayError(error));
      }
    })
  );

  app.post(
    MODEL_GATEWAY_PATHS.embeddings,
    ...internal,
    serve(async ({ body, call, res, signal }) => {
      const { input } = body;
      const model = typeof body.model === "string" ? body.model.trim() : "";
      const valid =
        typeof input === "string" ||
        (Array.isArray(input) &&
          input.length <= MAX_EMBEDDING_INPUTS &&
          input.every((text) => typeof text === "string"));

      if (!valid) {
        throw badRequest();
      }

      // The caller applied its own task prefixes; the space here only pins the
      // model and turns this process's prefixes off.
      const embeddingSpace = { documentPrefix: "", model, queryPrefix: "" };
      const vectors =
        typeof input === "string"
          ? [await embedQuery(input, { embeddingSpace, signal })]
          : await embedTexts(input, { embeddingSpace, signal });
      const answered = answeredEvent(call);

      res.json({
        data: vectors.map((vector, index) => ({
          embedding: Array.from(vector),
          index,
          object: "embedding",
        })),
        model:
          model ||
          resolveModelRouteForRuntime({
            capability: MODEL_CAPABILITIES.embedding,
            routeId: MODEL_ROUTE_IDS.embeddingDefault,
          }).modelName ||
          null,
        object: "list",
        usage: {
          prompt_tokens: answered?.inputTokens ?? 0,
          total_tokens: answered?.totalTokens ?? 0,
        },
        [MODEL_GATEWAY_EXTENSION_FIELD]: buildAnswerExtension(call, answered?.modelRoute),
      });
    })
  );

  app.post(
    MODEL_GATEWAY_PATHS.rerank,
    ...internal,
    serve(async ({ body, call, res, signal }) => {
      const { query, texts } = body;
      const model = typeof body.model === "string" ? body.model.trim() : "";

      if (
        typeof query !== "string" ||
        !Array.isArray(texts) ||
        texts.length > MAX_RERANK_TEXTS ||
        !texts.every((text) => typeof text === "string")
      ) {
        throw badRequest();
      }

      if (texts.length === 0) {
        res.json({ scores: [], [MODEL_GATEWAY_EXTENSION_FIELD]: buildAnswerExtension(call, null) });
        return;
      }

      const { modelRoute, scores } = await scoreTextsWithCrossEncoderBackend({
        dispatch: ({ model: resolvedModel, request }) =>
          upstreams.rerank.run({ model: resolvedModel || "cross-encoder", send: request }),
        model,
        queryText: query,
        // Stops the backend request when the caller leaves or its deadline
        // passes, as for chat and embeddings.
        signal,
        texts,
      });

      res.json({ scores, [MODEL_GATEWAY_EXTENSION_FIELD]: buildAnswerExtension(call, modelRoute) });
    })
  );

  app.get(MODEL_GATEWAY_PATHS.usage, ...internal, (req, res) => {
    const identity = req.serviceIdentity ?? {};
    const allowed =
      identity.system === true ||
      identity.claims?.admin === true ||
      buildAdminAccessDecision({
        permissionId: ADMIN_PERMISSION_IDS.adminStatusRead,
        principal: req.accessScope,
        requireAuthenticated: true,
      }).allowed;

    if (!allowed) {
      sendError(res, {
        ...describeModelGatewayError(null),
        code: MODEL_GATEWAY_ERROR_CODES.forbidden,
        message: "This identity may not read gateway usage.",
        status: 403,
      });
      return;
    }

    res.json({ quotas: quotas.describe(), usage: ledger.snapshot() });
  });

  // Unauthenticated so an orchestrator can probe it; it carries no secrets
  // (replica URLs cannot hold credentials, keys appear by id only).
  app.get(MODEL_GATEWAY_PATHS.health, (req, res) => {
    const keyStatus = getServiceKeyStatus(env);
    const status = keyStatus.configured ? "ok" : "error";

    res.status(status === "ok" ? 200 : 503).json({
      guard: getModelCallGuardTotals(),
      identity: {
        configured: keyStatus.configured,
        keyIds: keyStatus.keyIds,
        signingKeyId: keyStatus.signingKeyId,
      },
      quotas: quotas.describe(),
      role: "model-gateway",
      sharedState: getSharedStateProvider(),
      status,
      upstreams: {
        chat: upstreams.chat.describe(),
        embedding: upstreams.embedding.describe(),
        rerank: upstreams.rerank.describe(),
      },
    });
  });

  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found." } });
  });

  // Body parser failures (malformed JSON, a body over the limit) and anything
  // else a route did not answer, without echoing the request.
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const status = Number(error?.status);

    sendError(
      res,
      status >= 400 && status < 500
        ? {
            ...describeModelGatewayError(null),
            code: MODEL_GATEWAY_ERROR_CODES.badRequest,
            message: "The model gateway could not read this request.",
            status,
          }
        : describeModelGatewayError(null)
    );
  });

  app.locals.modelGateway = {
    close: () => resetModelUpstreamPools(),
    ledger,
    quotas,
    upstreams,
  };

  return app;
};
