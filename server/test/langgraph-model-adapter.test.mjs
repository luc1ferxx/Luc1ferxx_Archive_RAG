import "./langgraph-support/langsmith-off.mjs";

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";

import { createChatPromptTemplate } from "../lib/prompt-template.js";
import {
  buildIntentPlannerPrompt,
  buildIntentPlannerResponseFormat,
  getIntentPlannerPromptDescriptor,
  parseIntentPlannerJson,
} from "../rag/agent-intent-llm-adapter.js";
import { listAnswerPromptDescriptors } from "../rag/answer-writer.js";
import {
  LANGSMITH_TRACING_ENABLED_CODE,
  LANGSMITH_TRACING_VARIABLES,
} from "../rag/langgraph/langsmith-guard.js";
import {
  ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES,
  ArchiveRagChatModel,
} from "../rag/langgraph/model.js";
import {
  CIRCUIT_STATES,
  listModelCallGuardSnapshots,
  resetModelCallGuards,
} from "../rag/model-call-guard.js";
import { MODEL_CAPABILITIES, MODEL_ROUTE_IDS } from "../rag/model-providers/index.js";
import {
  completeTextWithMetadata,
  configureOpenAIProvider,
  resetOpenAIProvider,
} from "../rag/openai.js";
import { getRequestSignal, runWithRequestDeadline } from "../rag/request-deadline.js";
import { createRunUsage, getRunPromptUsage, runWithRunUsage } from "../rag/run-usage.js";

// Every direct-versus-adapter comparison below runs the same call twice, once
// through completeTextWithMetadata and once through ArchiveRagChatModel, and
// requires deepStrictEqual on everything the two can differ in: what the model
// (or the stand-in provider) receives, what comes back, the LLMOps events with
// only their clock fields masked, and what the active run is charged.

// Distinctive text in prompts and replies; it must never show up in an LLMOps
// event or in an error the adapter raises.
const PROMPT_SENTINEL = "QUOKKA-PROMPT-7731";
const REPLY_SENTINEL = "QUOKKA-REPLY-4419";

const withEnv = async (values, action) => {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const apply = (entries) => {
    for (const [name, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  apply(values);

  try {
    return await action();
  } finally {
    apply(saved);
  }
};

// Settings that change the openai.js path; cleared so a developer's shell (the
// test process inherits it) cannot move the call to a gateway, Redis or
// another limit.
const ISOLATED_MODEL_ENV = Object.freeze({
  MODEL_GATEWAY_URL: undefined,
  OPENAI_API_BASE: undefined,
  RAG_LLM_CIRCUIT_COOLDOWN_MS: undefined,
  RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: undefined,
  RAG_LLM_MAX_CONCURRENCY: undefined,
  RAG_SHARED_STATE: undefined,
  RAG_STRUCTURED_OUTPUT_ENABLED: undefined,
});

// LLMOps events as the real recorder writes them (recordRagTrace -> JSONL).
const withLlmOpsEvents = async (action) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "langgraph-model-adapter-"));
  const eventsPath = path.join(directory, "events.jsonl");
  const readEvents = async () =>
    (await readFile(eventsPath, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.eventType === "llmops_metric");

  try {
    return await withEnv(
      { ...ISOLATED_MODEL_ENV, RAG_OBSERVABILITY_ENABLED: "true", RAG_OBSERVABILITY_EVENTS_PATH: eventsPath },
      () => action(readEvents)
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

// Clock fields only: everything else in the event must match as recorded.
const maskClock = (event) => ({ ...event, latencyMs: "<masked>", timestamp: "<masked>" });

// One shared pair of callbacks for both sides, so the options a provider
// receives can be compared by identity; `sink` says which side is running.
const createStreamingCallbacks = () => {
  let sink = null;

  return {
    onAttemptStart: () => {
      sink.attempts += 1;
    },
    onTextDelta: (delta) => {
      sink.deltas.push(delta);
    },
    start: () => {
      sink = { attempts: 0, deltas: [] };
      return sink;
    },
  };
};

// Runs `call` inside its own run meter and returns what it produced, the
// LLMOps events it added and what the run was charged.
const runSide = async ({ call, readEvents, streaming = null }) => {
  const before = (await readEvents()).length;
  const runUsage = createRunUsage({
    limits: { maxCostUsd: 0, maxDurationMs: 0, maxTokens: 0 },
    startedAt: 0,
  });
  const streamed = streaming?.start() ?? null;
  let result;
  let error = null;

  try {
    result = await runWithRunUsage(runUsage, call);
  } catch (caught) {
    error = caught;
  }

  return {
    error,
    events: (await readEvents()).slice(before).map(maskClock),
    promptUsage: getRunPromptUsage(runUsage),
    result,
    streamed,
    used: runUsage.used,
  };
};

const createRecordingProvider = (reply) => {
  const calls = [];

  return {
    calls,
    provider: {
      completeText: async (input, options) => {
        calls.push({ input, options: { ...options } });

        if (typeof options.onTextDelta === "function") {
          for (const piece of reply.match(/.{1,12}/gs) ?? []) {
            options.onTextDelta(piece);
          }
        }

        return reply;
      },
    },
  };
};

const withProvider = async (reply, action) => {
  const recording = createRecordingProvider(reply);

  configureOpenAIProvider(recording.provider);

  try {
    return await action(recording.calls);
  } finally {
    resetOpenAIProvider();
  }
};

const getQaAnswerDescriptor = () => {
  const descriptor = listAnswerPromptDescriptors().find(
    (candidate) => candidate.id === "qa_answer" && candidate.version === "v2.2"
  );

  assert.ok(descriptor, "the qa_answer@v2.2 descriptor exists");
  return descriptor;
};

// The QA answer prompt's shape (answer-writer.js qaPromptV2): a system message
// with the rules and a human message with the question block, preferences and
// the retrieved evidence, rendered by the same lib/prompt-template.js.
const qaTemplate = createChatPromptTemplate([
  [
    "system",
    `You are a document-grounded assistant for uploaded PDFs.
Follow these rules strictly:
- Answer only from the provided evidence.
- Every evidence-based sentence must end with citations like [Source 1].
- JSON examples keep their braces: {{"answer":"..."}}`,
  ],
  [
    "human",
    `{questionBlock}

{preferenceBlock}

Retrieved evidence:
{context}

Grounded Answer:`,
  ],
]);

const renderQaPrompt = () =>
  qaTemplate.invoke({
    context: `[Source 1] vendor-a.pdf, page 2:\nEither party may terminate with 30 days' notice. ${PROMPT_SENTINEL}\n\n[Source 2] 供应商-b.pdf：通知期为六十天。  `,
    preferenceBlock: "Long-term memory: none.",
    questionBlock: `User Question:\nWhat is the notice period for vendor A? ${PROMPT_SENTINEL}`,
  });

const QA_REPLY = `The notice period is 30 days [Source 1]. ${REPLY_SENTINEL}`;

const PLANNER_CONTEXT = Object.freeze({
  candidates: [
    {
      id: "document_qa",
      plan: { mode: "document_rag", requiresDocuments: true, summary: "Answer from the documents." },
      reason: "A question about uploaded documents.",
    },
    {
      id: "compare_documents",
      plan: {
        mode: "compare",
        requiresDocuments: true,
        skillChain: ["compare_documents"],
        summary: "Compare two documents.",
        wantsCompareDocuments: true,
      },
      reason: "Two documents are named.",
    },
  ],
  docIds: ["doc-a", "doc-b"],
  question: `Which vendor has the longer notice period? ${PROMPT_SENTINEL}`,
});

// A planner reply the way a local model writes one: the JSON value, then prose
// after it (structured-output.js explains why the first value is kept).
const PLANNER_REPLY = `{"selectedIntentId":"compare_documents","reason":"Two vendors are compared."}\n${REPLY_SENTINEL} I chose comparison.`;

const plannerCall = () => {
  const responseFormat = buildIntentPlannerResponseFormat(PLANNER_CONTEXT);

  return {
    options: {
      capability: MODEL_CAPABILITIES.intentPlanner,
      promptTemplate: getIntentPlannerPromptDescriptor(),
      responseFormat,
      routeId: MODEL_ROUTE_IDS.intentPlannerDefault,
    },
    prompt: buildIntentPlannerPrompt(PLANNER_CONTEXT),
    responseFormat,
  };
};

const createPlannerModel = () => {
  const { options } = plannerCall();

  return new ArchiveRagChatModel({
    capability: options.capability,
    promptTemplate: options.promptTemplate,
    routeId: options.routeId,
  });
};

const assertNoTextIn = (value, label) => {
  const serialized = JSON.stringify(value);

  assert.ok(!serialized.includes(PROMPT_SENTINEL), `${label} carries no prompt text`);
  assert.ok(!serialized.includes(REPLY_SENTINEL), `${label} carries no reply text`);
};

const describeError = (error) =>
  error
    ? {
        code: error.code,
        message: error.message,
        name: error.name,
        retryAfterMs: error.retryAfterMs,
        status: error.status,
        upstreamStatus: error.upstreamStatus,
      }
    : null;

test("the chat model keeps LangChain's retry, queue, cache and console layers off", async () => {
  const model = new ArchiveRagChatModel();

  assert.equal(model._llmType(), "archive-rag");
  assert.equal(model.caller.maxRetries, 0);
  assert.equal(model.caller.maxConcurrency, Infinity);
  assert.equal(model.cache, undefined);
  assert.equal(model.verbose, false);
  assert.equal(model.outputVersion, "v0");
  for (const key of ["onAttemptStart", "onTextDelta", "promptTemplate", "responseFormat", "temperature"]) {
    assert.ok(model.callKeys.includes(key), `${key} is a declared call option`);
  }
  assert.equal(new ArchiveRagChatModel({ maxRetries: 0 }).caller.maxRetries, 0);

  for (const fields of [{ maxRetries: 2 }, { maxConcurrency: 4 }, { cache: true }, { verbose: true }]) {
    assert.throws(() => new ArchiveRagChatModel(fields), {
      code: ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.config,
    });
  }

  // A LangChain retry or fallback would repeat openai.js's own attempts.
  const structured = model.withStructuredOutput(
    { additionalProperties: false, properties: {}, type: "object" },
    { name: "probe" }
  );

  for (const runnable of [model, structured]) {
    assert.throws(() => runnable.withRetry(), {
      code: ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.unsupportedOption,
    });
    assert.throws(() => runnable.withFallbacks([model]), {
      code: ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.unsupportedOption,
    });
  }
});

test("an answer prompt reaches the provider, the run meter and the LLMOps log exactly as a direct call", async () => {
  const qa = getQaAnswerDescriptor();
  const prompt = renderQaPrompt();
  const streaming = createStreamingCallbacks();

  await withLlmOpsEvents((readEvents) =>
    withProvider(QA_REPLY, async (calls) => {
      const callOptions = {
        onAttemptStart: streaming.onAttemptStart,
        onTextDelta: streaming.onTextDelta,
        temperature: 0.2,
      };
      const direct = await runSide({
        call: () => completeTextWithMetadata(prompt, { ...callOptions, promptTemplate: qa }),
        readEvents,
        streaming,
      });
      const model = new ArchiveRagChatModel({ promptTemplate: qa });
      // Three ways a caller can hand the same prompt to the model: the
      // template's message list, the template's output object itself, and
      // LangChain message objects.
      const adapterSides = [];

      for (const input of [
        prompt.messages,
        prompt,
        [new SystemMessage(prompt.messages[0].content), new HumanMessage(prompt.messages[1].content)],
      ]) {
        adapterSides.push(
          await runSide({ call: () => model.invoke(input, callOptions), readEvents, streaming })
        );
      }

      assert.equal(calls.length, 4);
      assert.equal(direct.error, null);
      // The provider saw the role-headed rendering openai.js makes of a
      // message list, and the same options, callbacks included by identity.
      assert.match(calls[0].input, /^SYSTEM:\nYou are a document-grounded assistant/);
      assert.match(calls[0].input, /\n\nHUMAN:\nUser Question:/);
      assert.deepStrictEqual(calls[0].options, {
        onTextDelta: streaming.onTextDelta,
        responseFormat: null,
        temperature: 0.2,
      });
      assert.equal(direct.events.length, 1);
      assert.deepStrictEqual(direct.events[0].promptTemplate, { ...qa });
      assert.equal(direct.used.modelCalls, 1);

      for (const [index, adapter] of adapterSides.entries()) {
        assert.equal(adapter.error, null);
        assert.deepStrictEqual(calls[index + 1], calls[0]);
        assert.ok(adapter.result instanceof AIMessage);
        assert.equal(adapter.result.content, direct.result.text);
        assert.deepStrictEqual(adapter.result.response_metadata, {
          modelRoute: direct.result.modelRoute,
        });
        assert.deepStrictEqual(adapter.events, direct.events);
        assert.deepStrictEqual(adapter.used, direct.used);
        assert.deepStrictEqual(adapter.promptUsage, direct.promptUsage);
        assert.deepStrictEqual(adapter.streamed, direct.streamed);
      }

      assert.equal(direct.streamed.attempts, 1);
      assert.equal(direct.streamed.deltas.join(""), QA_REPLY);
    })
  );
});

test("a planner call through withStructuredOutput sends the planner's own string prompt and strict response_format", async () => {
  const { options, prompt, responseFormat } = plannerCall();
  const { name, schema } = responseFormat.json_schema;

  assert.equal(typeof prompt, "string");

  await withLlmOpsEvents((readEvents) =>
    withProvider(PLANNER_REPLY, async (calls) => {
      const direct = await runSide({
        call: () => completeTextWithMetadata(prompt, options),
        readEvents,
      });
      const model = createPlannerModel();
      const withRaw = await runSide({
        call: () => model.withStructuredOutput(schema, { includeRaw: true, name }).invoke(prompt),
        readEvents,
      });
      const parsedOnly = await runSide({
        call: () => model.withStructuredOutput(schema, { name }).invoke(prompt),
        readEvents,
      });

      assert.equal(calls.length, 3);
      // A string prompt reaches openai.js as the same string, not as a
      // one-message list rendered "HUMAN:\n...".
      assert.equal(calls[0].input, prompt);
      assert.deepStrictEqual(calls[0].options, {
        onTextDelta: undefined,
        responseFormat,
      });
      assert.equal(responseFormat.json_schema.strict, true);
      assert.deepStrictEqual(calls[1], calls[0]);
      assert.deepStrictEqual(calls[2], calls[0]);

      assert.equal(direct.result.modelRoute.capability, MODEL_CAPABILITIES.intentPlanner);
      assert.equal(direct.events.length, 1);
      assert.equal(direct.used.modelCalls, 1);
      assert.equal(withRaw.result.raw.content, direct.result.text);
      assert.deepStrictEqual(withRaw.result.raw.response_metadata, {
        modelRoute: direct.result.modelRoute,
      });
      // The first complete JSON value, as the planner's own parser reads it.
      assert.deepStrictEqual(withRaw.result.parsed, parseIntentPlannerJson(direct.result.text));
      assert.deepStrictEqual(parsedOnly.result, withRaw.result.parsed);

      for (const adapter of [withRaw, parsedOnly]) {
        assert.deepStrictEqual(adapter.events, direct.events);
        assert.deepStrictEqual(adapter.used, direct.used);
        assert.deepStrictEqual(adapter.promptUsage, direct.promptUsage);
      }
    })
  );
});

test("with structured output switched off both paths drop the response_format alike", async () => {
  const { options, prompt, responseFormat } = plannerCall();
  const { name, schema } = responseFormat.json_schema;

  await withLlmOpsEvents((readEvents) =>
    withEnv({ RAG_STRUCTURED_OUTPUT_ENABLED: "false" }, () =>
      withProvider(PLANNER_REPLY, async (calls) => {
        const direct = await runSide({
          call: () => completeTextWithMetadata(prompt, options),
          readEvents,
        });
        const adapter = await runSide({
          call: () => createPlannerModel().withStructuredOutput(schema, { name }).invoke(prompt),
          readEvents,
        });

        assert.equal(calls[0].options.responseFormat, null);
        assert.equal(direct.events.length, 1);
        assert.deepStrictEqual(calls[1], calls[0]);
        assert.deepStrictEqual(adapter.result, parseIntentPlannerJson(direct.result.text));
        assert.deepStrictEqual(adapter.events, direct.events);
      })
    )
  );
});

test("a string prompt and a one-message human list keep their own renderings", async () => {
  const text = `  Summarize the renewal clause. ${PROMPT_SENTINEL}  `;

  await withLlmOpsEvents((readEvents) =>
    withProvider("ok", async (calls) => {
      const model = new ArchiveRagChatModel();
      const directString = await runSide({ call: () => completeTextWithMetadata(text), readEvents });
      const adapterString = await runSide({ call: () => model.invoke(text), readEvents });
      const humanPrompt = { messages: [{ content: text, role: "human" }] };
      const directHuman = await runSide({
        call: () => completeTextWithMetadata(humanPrompt),
        readEvents,
      });
      const adapterHuman = await runSide({ call: () => model.invoke([["human", text]]), readEvents });

      assert.equal(calls[0].input, text);
      assert.deepStrictEqual(calls[1], calls[0]);
      assert.equal(calls[2].input, `HUMAN:\n${text.trim()}`);
      assert.deepStrictEqual(calls[3], calls[2]);
      assert.equal(directString.events.length, 1);
      assert.equal(directHuman.events.length, 1);
      assert.deepStrictEqual(adapterString.events, directString.events);
      assert.deepStrictEqual(adapterHuman.events, directHuman.events);
      // The two renderings differ in length, and the estimate follows it.
      assert.notEqual(directString.events[0].inputCharacters, directHuman.events[0].inputCharacters);
    })
  );
});

test("the template reaches the LLMOps event and the run ledger, and no prompt or reply text does", async () => {
  const qa = getQaAnswerDescriptor();
  const planner = getIntentPlannerPromptDescriptor();
  const prompt = renderQaPrompt();

  await withLlmOpsEvents((readEvents) =>
    withProvider(QA_REPLY, async () => {
      const model = new ArchiveRagChatModel({ promptTemplate: qa });
      const fromModel = await runSide({ call: () => model.invoke(prompt.messages), readEvents });
      // A per-call promptTemplate wins over the model's, as it would be the
      // option a direct caller passes.
      const direct = await runSide({
        call: () => completeTextWithMetadata(prompt, { promptTemplate: planner }),
        readEvents,
      });
      const fromCall = await runSide({
        call: () => model.invoke(prompt.messages, { promptTemplate: planner }),
        readEvents,
      });

      assert.deepStrictEqual(fromModel.events[0].promptTemplate, { ...qa });
      assert.deepStrictEqual(fromModel.promptUsage, [{ ...qa, calls: 1, tokens: fromModel.used.tokens }]);
      assert.deepStrictEqual(fromCall.events[0].promptTemplate, { ...planner });
      assert.deepStrictEqual(fromCall.events, direct.events);
      assert.equal(fromModel.events[0].prompt, undefined);

      const allEvents = await readEvents();

      assert.equal(allEvents.length, 3);
      assertNoTextIn(allEvents, "the LLMOps events");
      assertNoTextIn(fromModel.result.response_metadata, "the reply metadata");
    })
  );
});

test("calls the request cannot carry are refused before the model is called, without echoing text", async () => {
  const { responseFormat } = plannerCall();
  const { name, schema } = responseFormat.json_schema;

  await withLlmOpsEvents((readEvents) =>
    withProvider(`no json here ${REPLY_SENTINEL}`, async (calls) => {
      const model = new ArchiveRagChatModel();
      const refusals = [
        [model.invoke([new AIMessage(`earlier answer ${PROMPT_SENTINEL}`)]), "unsupportedMessage"],
        [
          model.invoke([new ToolMessage({ content: PROMPT_SENTINEL, tool_call_id: "call-1" })]),
          "unsupportedMessage",
        ],
        [model.invoke([{ content: PROMPT_SENTINEL, role: "developer" }]), "unsupportedMessage"],
        [
          model.invoke([new HumanMessage({ content: [{ text: PROMPT_SENTINEL, type: "text" }] })]),
          "unsupportedMessage",
        ],
        [model.invoke(PROMPT_SENTINEL, { stop: ["\n"] }), "unsupportedOption"],
        [model.invoke(PROMPT_SENTINEL, { tools: [] }), "unsupportedOption"],
      ];

      for (const [promise, code] of refusals) {
        await assert.rejects(promise, (error) => {
          assert.equal(error.code, ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES[code]);
          assertNoTextIn(error.message, "the refusal");
          return true;
        });
      }

      // The unrendered template object is not a prompt: refused, never sent.
      await assert.rejects(model.invoke(qaTemplate), TypeError);

      assert.equal(calls.length, 0);
      assert.equal((await readEvents()).length, 0);

      for (const [schemaArgument, config] of [
        [schema, { method: "jsonMode", name }],
        [schema, { method: "functionCalling", name }],
        [schema, { name, strict: false }],
        [schema, {}],
        [schema, { name: "not a valid name" }],
        [z.object({ selectedIntentId: z.string() }), { name }],
        [null, { name }],
      ]) {
        assert.throws(() => model.withStructuredOutput(schemaArgument, config), {
          code: ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.structuredOutputConfig,
        });
      }

      // A reply with no JSON value: an error without the reply, or with
      // includeRaw the raw message and parsed null, as LangChain's contract has it.
      await assert.rejects(model.withStructuredOutput(schema, { name }).invoke("pick one"), (error) => {
        assert.equal(error.code, ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.structuredOutputParse);
        assertNoTextIn(error.message, "the parse error");
        return true;
      });

      const withRaw = await model
        .withStructuredOutput(schema, { includeRaw: true, name })
        .invoke("pick one");

      assert.equal(withRaw.parsed, null);
      assert.equal(withRaw.raw.content, `no json here ${REPLY_SENTINEL}`);
    })
  );
});

test("LangSmith tracing set to true refuses the model, its structured runnable and every call", async () => {
  const { responseFormat } = plannerCall();
  const { name, schema } = responseFormat.json_schema;
  const isRefusal = { code: LANGSMITH_TRACING_ENABLED_CODE };

  for (const variable of LANGSMITH_TRACING_VARIABLES) {
    await withEnv({ [variable]: "true" }, async () => {
      assert.throws(() => new ArchiveRagChatModel(), isRefusal);
    });
  }

  await withLlmOpsEvents((readEvents) =>
    withProvider("ok", async (calls) => {
      // Built while tracing was off; the variable is set afterwards, which a
      // check at start-up alone would miss.
      const model = new ArchiveRagChatModel();
      const structured = model.withStructuredOutput(schema, { name });

      await withEnv({ LANGSMITH_TRACING: "true" }, async () => {
        await assert.rejects(model.invoke("ping"), isRefusal);
        await assert.rejects(model.generate([[new HumanMessage("ping")]]), isRefusal);
        await assert.rejects(structured.invoke("ping"), isRefusal);
        assert.throws(() => model.withStructuredOutput(schema, { name }), isRefusal);
      });

      assert.equal(calls.length, 0);
      assert.equal((await readEvents()).length, 0);

      // Off again, the same objects work.
      assert.equal((await model.invoke("ping")).content, "ok");
      assert.equal(calls.length, 1);
    })
  );
});

// A local OpenAI-compatible endpoint that keeps every request body as the
// bytes it received. `respond` picks the answer per request.
const startFakeOpenAI = async () => {
  const requests = [];
  let respond = () => ({ content: "pong", status: 200 });
  const server = http.createServer((request, response) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body,
        contentType: request.headers["content-type"],
        method: request.method,
        url: request.url,
      });

      const payload = JSON.parse(body);
      const answer = respond(payload);

      // A slow model: the answer goes out after `delayMs`.
      setTimeout(() => sendAnswer(payload, answer, response), answer.delayMs ?? 0);
    });
  });
  const sendAnswer = (payload, answer, response) => {
    if (answer.status !== 200) {
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Service unavailable." } }));
      return;
    }

    const usage = { completion_tokens: 9, prompt_tokens: 31, total_tokens: 40 };

    if (payload.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of answer.content.match(/.{1,10}/gs) ?? []) {
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: piece }, finish_reason: null, index: 0 }] })}\n\n`
        );
      }
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}\n\n`
      );
      response.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: { content: answer.content, role: "assistant" },
          },
        ],
        model: payload.model,
        usage,
      })
    );
  };

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
    requests,
    setResponder: (next) => {
      respond = next;
    },
  };
};

const withFakeOpenAI = async (action) => {
  const server = await startFakeOpenAI();

  try {
    return await withLlmOpsEvents((readEvents) =>
      withEnv(
        {
          OPENAI_API_KEY: "langgraph-adapter-test",
          OPENAI_BASE_URL: server.baseUrl,
          OPENAI_CHAT_FALLBACK_MODEL: "",
          OPENAI_CHAT_MODEL: "adapter-primary",
          RAG_LLM_REQUEST_TIMEOUT_MS: "5000",
        },
        () => action({ readEvents, server })
      )
    );
  } finally {
    resetOpenAIProvider();
    await server.close();
  }
};

// Each side starts from fresh clients and a closed circuit, so neither inherits
// the other's breaker state, and returns only the requests it sent.
const runHttpSide = async ({ call, readEvents, server, streaming = null }) => {
  resetOpenAIProvider();
  const before = server.requests.length;
  const side = await runSide({ call, readEvents, streaming });

  return { ...side, requests: server.requests.slice(before) };
};

test("over HTTP the adapter sends byte-identical requests and gets the same answers", async () => {
  const qa = getQaAnswerDescriptor();
  const prompt = renderQaPrompt();
  const planner = plannerCall();
  const { name, schema } = planner.responseFormat.json_schema;
  const streaming = createStreamingCallbacks();

  await withFakeOpenAI(async ({ readEvents, server }) => {
    server.setResponder((payload) => ({
      content: payload.response_format ? PLANNER_REPLY : `  ${QA_REPLY}\n`,
      status: 200,
    }));

    const pairs = [
      {
        adapter: () =>
          new ArchiveRagChatModel({ promptTemplate: qa, temperature: 0 }).invoke(prompt.messages),
        direct: () => completeTextWithMetadata(prompt, { promptTemplate: qa, temperature: 0 }),
        label: "answer",
      },
      {
        adapter: () =>
          new ArchiveRagChatModel({ promptTemplate: qa }).invoke(prompt.messages, {
            onAttemptStart: streaming.onAttemptStart,
            onTextDelta: streaming.onTextDelta,
          }),
        direct: () =>
          completeTextWithMetadata(prompt, {
            onAttemptStart: streaming.onAttemptStart,
            onTextDelta: streaming.onTextDelta,
            promptTemplate: qa,
          }),
        label: "streamed answer",
        streaming,
      },
      {
        adapter: () =>
          createPlannerModel().withStructuredOutput(schema, { includeRaw: true, name }).invoke(planner.prompt),
        direct: () => completeTextWithMetadata(planner.prompt, planner.options),
        label: "planner",
        parsed: (direct) => parseIntentPlannerJson(direct.result.text),
      },
    ];

    for (const pair of pairs) {
      const direct = await runHttpSide({
        call: pair.direct,
        readEvents,
        server,
        streaming: pair.streaming,
      });
      const adapter = await runHttpSide({
        call: pair.adapter,
        readEvents,
        server,
        streaming: pair.streaming,
      });
      const adapterMessage = adapter.result?.raw ?? adapter.result;

      assert.equal(direct.error, null, pair.label);
      assert.equal(adapter.error, null, pair.label);
      assert.equal(direct.requests.length, 1, pair.label);
      assert.equal(direct.events.length, 1, pair.label);
      assert.equal(direct.used.modelCalls, 1, pair.label);
      assert.deepStrictEqual(adapter.requests, direct.requests, pair.label);
      assert.equal(adapterMessage.content, direct.result.text, pair.label);
      assert.deepStrictEqual(
        adapterMessage.response_metadata,
        { modelRoute: direct.result.modelRoute },
        pair.label
      );
      assert.deepStrictEqual(adapter.events, direct.events, pair.label);
      assert.deepStrictEqual(adapter.used, direct.used, pair.label);
      assert.deepStrictEqual(adapter.promptUsage, direct.promptUsage, pair.label);
      assert.deepStrictEqual(adapter.streamed, direct.streamed, pair.label);

      if (pair.parsed) {
        assert.deepStrictEqual(adapter.result.parsed, pair.parsed(direct), pair.label);
      }

      if (pair.streaming) {
        // The stream really ran: one attempt, every delta of the raw reply.
        assert.equal(direct.streamed.attempts, 1, pair.label);
        assert.equal(direct.streamed.deltas.join(""), `  ${QA_REPLY}\n`, pair.label);
      }
    }

    const [answerBody, streamedBody, plannerBody] = server.requests
      .filter((_, index) => index % 2 === 0)
      .map((request) => JSON.parse(request.body));

    assert.deepStrictEqual(answerBody.messages.map((message) => message.role), ["system", "user"]);
    assert.equal(answerBody.temperature, 0);
    assert.equal(streamedBody.stream, true);
    assert.deepStrictEqual(plannerBody.messages, [{ content: planner.prompt, role: "user" }]);
    assert.deepStrictEqual(plannerBody.response_format, planner.responseFormat);
  });
});

test("over HTTP a 503 is retried by openai.js alone: the adapter sends exactly as many requests", async () => {
  const qa = getQaAnswerDescriptor();
  const prompt = renderQaPrompt();

  await withFakeOpenAI(async ({ readEvents, server }) => {
    server.setResponder(() => ({ status: 503 }));

    const direct = await runHttpSide({
      call: () => completeTextWithMetadata(prompt, { promptTemplate: qa }),
      readEvents,
      server,
    });
    const adapter = await runHttpSide({
      call: () => new ArchiveRagChatModel({ promptTemplate: qa }).invoke(prompt.messages),
      readEvents,
      server,
    });

    // One try plus openai.js's three retries. A LangChain retry layer on top
    // would repeat that whole sequence up to six more times.
    assert.equal(direct.requests.length, 4);
    assert.deepStrictEqual(adapter.requests, direct.requests);
    assert.deepStrictEqual(describeError(adapter.error), describeError(direct.error));
    assert.equal(direct.error.status, 503);
    assert.equal(direct.events.length, 1);
    assert.equal(direct.events[0].status, "error");
    assert.deepStrictEqual(adapter.events, direct.events);
    assert.deepStrictEqual(adapter.used, direct.used);
    assertNoTextIn(adapter.events, "the error event");
  });
});

// The drain decision (docs/adr/0001-langgraph-runtime.md): LangChain's abort
// signal does not reach openai.js; the request deadline does.

const createDeferred = () => {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

// A provider that honours an abort signal the way a real client does: the
// call rejects with the signal's reason as soon as it aborts.
const withGatedProvider = async (reply, action) => {
  const calls = [];
  const gate = createDeferred();
  const started = createDeferred();

  configureOpenAIProvider({
    completeText: (input, options) => {
      calls.push({ input, options: { ...options } });
      started.resolve();

      return new Promise((resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        gate.promise.then(() => resolve(reply));
      });
    },
  });

  try {
    return await action({ calls, gate, started });
  } finally {
    resetOpenAIProvider();
  }
};

test("a LangChain abort signal is not passed on, a timeout is refused, and the request deadline still is", async () => {
  const prompt = renderQaPrompt();
  const { responseFormat } = plannerCall();
  const { name, schema } = responseFormat.json_schema;

  await withLlmOpsEvents((readEvents) =>
    withProvider(QA_REPLY, async (calls) => {
      const model = new ArchiveRagChatModel();
      const direct = await runSide({ call: () => completeTextWithMetadata(prompt), readEvents });
      const aborted = new AbortController();

      aborted.abort(new Error("a sibling task failed"));
      const adapter = await runSide({
        call: () => model.invoke(prompt.messages, { signal: aborted.signal }),
        readEvents,
      });

      // An already aborted LangChain signal changes nothing: the provider
      // gets exactly the direct call's options, no signal among them.
      assert.equal(adapter.error, null);
      assert.deepStrictEqual(calls[1], calls[0]);
      assert.equal(Object.hasOwn(calls[1].options, "signal"), false);
      assert.equal(adapter.result.content, direct.result.text);
      assert.deepStrictEqual(adapter.events, direct.events);

      // A timeout would become such a signal and do nothing; it is refused.
      for (const call of [
        () => model.invoke(prompt.messages, { timeout: 50 }),
        () => model.generate([[new HumanMessage("ping")]], { timeout: 50 }),
        () => model.withStructuredOutput(schema, { name }).invoke("ping", { timeout: 50 }),
        () => model.withConfig({ timeout: 50 }).invoke("ping"),
      ]) {
        await assert.rejects(call(), (error) => {
          assert.equal(error.code, ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.unsupportedOption);
          assert.match(error.message, /timeout/);
          return true;
        });
      }

      assert.equal(calls.length, 2);

      // Inside a bound request both paths hand the provider the request's own
      // signal (openai.js withRequestSignal), whatever LangChain signal the
      // adapter was given.
      const requestSignals = [];

      await runWithRequestDeadline({ deadlineAt: Date.now() + 60_000 }, async () => {
        requestSignals.push(getRequestSignal());
        await completeTextWithMetadata(prompt);
        await model.invoke(prompt.messages, { signal: new AbortController().signal });
      });

      assert.ok(requestSignals[0] instanceof AbortSignal);
      assert.equal(calls.length, 4);
      assert.equal(calls[2].options.signal, requestSignals[0]);
      assert.equal(calls[3].options.signal, requestSignals[0]);
      assert.deepStrictEqual(calls[3], calls[2]);
    })
  );
});

test("a LangChain signal aborted mid-flight leaves the model call running to its answer", async () => {
  await withLlmOpsEvents((readEvents) =>
    withGatedProvider(QA_REPLY, async ({ calls, gate, started }) => {
      const controller = new AbortController();
      let settled = false;
      const pending = new ArchiveRagChatModel()
        .invoke("ping", { signal: controller.signal })
        .finally(() => {
          settled = true;
        });

      await started.promise;
      controller.abort(new Error("a sibling task failed"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "the call waits for the model instead of rejecting on abort");

      gate.resolve();
      assert.equal((await pending).content, QA_REPLY);
      assert.equal(Object.hasOwn(calls[0].options, "signal"), false);

      const events = await readEvents();

      assert.equal(events.length, 1);
      assert.equal(events[0].status, "ok");
    })
  );
});

test("inside LangGraph a failing sibling node does not abort an in-flight model call", async () => {
  await withGatedProvider(QA_REPLY, async ({ calls, gate, started }) => {
    const model = new ArchiveRagChatModel();
    let modelCall = null;
    let modelSettled = false;
    const graph = new StateGraph(
      Annotation.Root({
        replies: Annotation({ default: () => [], reducer: (left, right) => left.concat(right) }),
      })
    )
      .addNode("ask", async () => {
        // No signal is passed here: LangGraph's own run signal reaches the
        // model through the implicit RunnableConfig, and LangGraph aborts it
        // when a sibling task fails.
        modelCall = model.invoke("ping");
        modelCall.then(
          () => {
            modelSettled = true;
          },
          () => {
            modelSettled = true;
          }
        );
        return { replies: [(await modelCall).content] };
      })
      .addNode("fail", async () => {
        await started.promise;
        throw new Error("a sibling task failed");
      })
      .addEdge(START, "ask")
      .addEdge(START, "fail")
      .addEdge("ask", END)
      .addEdge("fail", END)
      .compile();

    try {
      // LangGraph rejects as soon as the sibling fails; the 2 s bound only
      // keeps a regression from hanging the suite.
      const graphError = await Promise.race([
        graph.invoke({}).then(
          () => new Error("the graph completed"),
          (error) => error
        ),
        new Promise((resolve) => {
          setTimeout(() => resolve(new Error("the graph did not settle")), 2_000).unref();
        }),
      ]);

      assert.equal(graphError.message, "a sibling task failed");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(modelSettled, false, "the model call is still waiting for its answer");
    } finally {
      gate.resolve();
    }

    assert.equal((await modelCall).content, QA_REPLY);
    assert.equal(calls.length, 1);
    assert.equal(Object.hasOwn(calls[0].options, "signal"), false);
  });
});

test("over HTTP a LangChain timeout signal neither cuts the request nor reaches the circuit breaker", async () => {
  await withFakeOpenAI(async ({ server }) => {
    server.setResponder(() => ({ content: "pong", delayMs: 120, status: 200 }));
    resetOpenAIProvider();
    resetModelCallGuards();

    try {
      const model = new ArchiveRagChatModel();

      // More calls than the breaker's default threshold (5): each one's
      // LangChain signal times out long before the model answers.
      for (let index = 0; index < 6; index += 1) {
        assert.equal((await model.invoke("ping", { signal: AbortSignal.timeout(20) })).content, "pong");
      }

      const snapshots = listModelCallGuardSnapshots();

      assert.equal(server.requests.length, 6);
      assert.equal(snapshots.length, 1);
      assert.deepStrictEqual(snapshots[0][1].breaker, {
        consecutiveFailures: 0,
        state: CIRCUIT_STATES.closed,
      });
    } finally {
      resetModelCallGuards();
    }
  });
});
