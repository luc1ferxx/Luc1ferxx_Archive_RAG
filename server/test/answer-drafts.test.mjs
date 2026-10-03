import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { runWithAgentEventSink } from "../rag/agent-event-stream.js";
import { runAgentRag } from "../rag/agent.js";
import {
  createAnswerDraftReleaser,
  findCompletePrefix,
  runWithAnswerDraftChannel,
} from "../rag/answer-drafts.js";
import { writeQaAnswer } from "../rag/answer-writer.js";
import { createChatClient } from "../rag/openai-client.js";
import {
  completeTextWithMetadata,
  configureOpenAIProvider,
  resetOpenAIProvider,
} from "../rag/openai.js";
import {
  buildScopedRagService,
  createEvalTelemetry,
} from "../evaluation/agent-eval-harness.js";
import {
  DEFAULT_ACCESS_SCOPE,
  sameTrajectoryScope as sameScope,
} from "../evaluation/trajectory/checks.js";
import { isAgentVerdictOverridden } from "../evaluation/agent-answer-outcome.js";

const CITATION = {
  docId: "contract-1",
  excerpt:
    "The agreement renews every 12 months unless either party gives 30 days notice. The monthly fee is 12.5 thousand dollars.",
  fileName: "services-agreement.pdf",
  pageNumber: 3,
};

const withEnv = (t, values) => {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

// Collects every agent event a streaming request would send.
const captureEvents = (action) => {
  const events = [];
  return runWithAgentEventSink((event) => events.push(event), action).then((result) => ({
    events,
    result,
  }));
};

const draftTexts = (events) =>
  events.filter((event) => event.type === "answer_draft").map((event) => event.draft.text);

// Feeds a completion to a releaser the way a streaming model would.
const stream = (options, text, pieceLength = 7) => {
  options.onAttemptStart();
  for (let index = 0; index < text.length; index += pieceLength) {
    options.onTextDelta(text.slice(index, index + pieceLength));
  }
};

// The citation follows the full stop, so a sentence checked at its full stop
// would be judged without its source and held back forever.
test("a sentence is finished only once its citation and what follows have arrived", () => {
  const cases = [
    ["Renews every 12 months.", ""],
    ["Renews every 12 months. [Sou", ""],
    ["Renews every 12 months. [Source 1]", ""],
    ["Renews every 12 months. [Source 1] The", "Renews every 12 months. [Source 1]"],
    ["Renews every 12 months. [Source 1]\nFee is 12.", "Renews every 12 months. [Source 1]\n"],
    ["Fee is 12.5 k", ""],
    ["续约期为12个月。[来源 1]", ""],
    ["续约期为12个月。[来源 1]费用", "续约期为12个月。[来源 1]"],
  ];

  for (const [streamed, finished] of cases) {
    assert.equal(findCompletePrefix(streamed), finished, streamed);
  }
});

test("drafts exist only for a streaming client inside a draft channel", async () => {
  assert.equal(createAnswerDraftReleaser({ citations: [CITATION] }), null);
  // A channel without a streaming client is not opened.
  assert.equal(
    await runWithAnswerDraftChannel(() => createAnswerDraftReleaser({ citations: [CITATION] })),
    null
  );
  // A client without a channel, e.g. a Skill's own model call, gets none either.
  const { result } = await captureEvents(async () =>
    createAnswerDraftReleaser({ citations: [CITATION] })
  );
  assert.equal(result, null);
});

test("only sentences the claim check supports are sent, in order, as they complete", async () => {
  const answer = [
    "The agreement renews every 12 months. [Source 1]",
    "The contract was signed in Paris. [Source 1]",
    "The monthly fee is 12.5 thousand dollars. [Source 1]",
  ].join("\n");

  const { events } = await captureEvents(() =>
    runWithAnswerDraftChannel(async () => {
      const drafts = createAnswerDraftReleaser({ citations: [CITATION] });
      const sentAfterFirstLine = [];
      drafts.completionOptions.onAttemptStart();

      for (const [index, piece] of answer.match(/[\s\S]{1,5}/g).entries()) {
        drafts.completionOptions.onTextDelta(piece);
        if (index === 11) sentAfterFirstLine.push(true);
      }
      drafts.finish(answer);
    })
  );

  // The unsupported Paris claim is held back; "12.5" was never split into
  // "12." and "5" while it streamed.
  assert.deepEqual(draftTexts(events), [
    "The agreement renews every 12 months. [Source 1]",
    "The monthly fee is 12.5 thousand dollars. [Source 1]",
  ]);
  assert.deepEqual(
    events.filter((event) => event.type === "answer_draft").map((event) => event.draft.index),
    [0, 1]
  );
});

test("a sentence is sent before the rest of the answer has been generated", async () => {
  const seen = [];

  await runWithAgentEventSink(
    (event) => seen.push(event),
    () =>
      runWithAnswerDraftChannel(async () => {
        const drafts = createAnswerDraftReleaser({ citations: [CITATION] });
        drafts.completionOptions.onAttemptStart();
        drafts.completionOptions.onTextDelta("The agreement renews every 12 months. [Source 1]\n");
        assert.equal(draftTexts(seen).length, 1, "released at the line break");
        drafts.completionOptions.onTextDelta("The monthly fee is 12.5 thousand");
        assert.equal(draftTexts(seen).length, 1, "an unfinished sentence waits");
      })
  );
});

test("a retry drops the drafts a failed attempt already sent", async () => {
  const { events } = await captureEvents(() =>
    runWithAnswerDraftChannel(async () => {
      const drafts = createAnswerDraftReleaser({ citations: [CITATION] });
      stream(drafts.completionOptions, "The agreement renews every 12 months. [Source 1]\nThe mon");
      // The connection drops; the model call retries from scratch.
      stream(drafts.completionOptions, "The monthly fee is 12.5 thousand dollars. [Source 1]\n");
      drafts.finish("The monthly fee is 12.5 thousand dollars. [Source 1]");
    })
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["answer_draft", "answer_draft_reset", "answer_draft"]
  );
  assert.equal(events.at(-1).draft.index, 0, "numbering restarts after a reset");
});

const startStreamingServer = async (respond) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      respond(response, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    requests,
    url: `http://127.0.0.1:${server.address().port}/v1`,
  };
};

const writeSse = (response, pieces, { usage = null } = {}) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const piece of pieces) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, index: 0 }] })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}\n\n`);
  if (usage) response.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  response.end("data: [DONE]\n\n");
};

test("the streaming client reads OpenAI-style chunks, content, finish reason, and usage", async (t) => {
  const server = await startStreamingServer((response) =>
    writeSse(response, ["Hel", "lo", " world"], {
      usage: { completion_tokens: 3, prompt_tokens: 5, total_tokens: 8 },
    })
  );
  t.after(() => server.close());
  withEnv(t, { OPENAI_BASE_URL: server.url });
  const deltas = [];

  const result = await createChatClient({ apiKey: "test", model: "m" }).invokeStream("hi", {
    onDelta: (delta) => deltas.push(delta),
  });

  assert.deepEqual(deltas, ["Hel", "lo", " world"]);
  assert.deepEqual(result, {
    content: "Hello world",
    finishReason: "stop",
    usage: { completion_tokens: 3, prompt_tokens: 5, total_tokens: 8 },
  });
  assert.equal(server.requests[0].stream, true);
  assert.deepEqual(server.requests[0].stream_options, { include_usage: true });
});

test("a streamed completion that fails before it starts is retried from the top", async (t) => {
  const server = await startStreamingServer((response, count) => {
    if (count === 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "busy" } }));
      return;
    }
    writeSse(response, ["po", "ng"], { usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 } });
  });
  t.after(() => server.close());
  withEnv(t, {
    OPENAI_API_KEY: "test",
    OPENAI_BASE_URL: server.url,
    OPENAI_CHAT_FALLBACK_MODEL: "",
    OPENAI_CHAT_MODEL: `stream-${Date.now()}`,
  });
  const calls = [];

  const completion = await completeTextWithMetadata("ping", {
    onAttemptStart: () => calls.push("attempt"),
    onTextDelta: (delta) => calls.push(delta),
  });

  assert.equal(completion.text, "pong");
  assert.deepEqual(calls, ["attempt", "attempt", "po", "ng"]);
});

const askDocumentQuestion = (t, answer) => {
  configureOpenAIProvider({
    completeText: async (_input, { onTextDelta } = {}) => {
      for (const piece of answer.match(/[\s\S]{1,6}/g)) onTextDelta?.(piece);
      return answer;
    },
  });
  t.after(() => resetOpenAIProvider());

  const ragService = buildScopedRagService({
    chat: async ({ question }) => {
      const written = await writeQaAnswer({
        bundle: { citations: [CITATION], context: `[Source 1]\n${CITATION.excerpt}` },
        query: question,
        resolvedQuery: question,
      });
      return { ...written, abstained: false, memoryApplied: false, resolvedQuery: question };
    },
    documents: [{ docId: "contract-1", fileName: CITATION.fileName }],
    sameScope,
    telemetry: createEvalTelemetry(),
  });

  return () =>
    runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      docIds: ["contract-1"],
      question: "What are the renewal term and the monthly fee?",
      ragService,
      sessionId: "draft-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => ({ text: "" }),
    });
};

test("a fully supported answer streams drafts that appear verbatim in the final answer", async (t) => {
  const ask = askDocumentQuestion(
    t,
    [
      "The agreement renews every 12 months. [Source 1]",
      "The monthly fee is 12.5 thousand dollars. [Source 1]",
    ].join("\n")
  );

  const { events, result: streamed } = await captureEvents(ask);
  const plain = await ask();
  const drafts = draftTexts(events);

  assert.equal(drafts.length, 2);
  for (const draft of drafts) {
    assert.ok(streamed.body.agentAnswer.includes(draft), draft);
  }
  // Streaming changes nothing about the answer itself.
  assert.equal(streamed.body.agentAnswer, plain.body.agentAnswer);
  // Drafts arrive before the run finishes: the finalizer step comes after.
  const firstDraft = events.findIndex((event) => event.type === "answer_draft");
  const finalizer = events.findIndex(
    (event) => event.type === "trace_step" && event.step.type === "answer_finalizer"
  );
  assert.ok(firstDraft >= 0 && finalizer > firstDraft);
});

// The case the eval counts as a retraction: the loop could not verify one
// claim, retried retrieval, and asked for clarification instead of answering.
// The verified draft was real, but the answer the user gets is different.
test("an unverifiable claim is never drafted, and the result can still withdraw the drafts", async (t) => {
  const ask = askDocumentQuestion(
    t,
    [
      "The agreement renews every 12 months. [Source 1]",
      "The contract was signed in Paris. [Source 1]",
    ].join("\n")
  );

  const { events, result: streamed } = await captureEvents(ask);
  const plain = await ask();

  assert.deepEqual(draftTexts(events), ["The agreement renews every 12 months. [Source 1]"]);
  assert.equal(streamed.body.agentAnswer, plain.body.agentAnswer);
  assert.equal(streamed.body.agentMode, "clarification");
});

// RAG_QA_VERDICT_OVERRIDE=supported: a reply that opened with NOT_IN_EVIDENCE:
// is never streamed, even when the override then answers with its claims.
test("a reply opening with the not-in-evidence marker is never drafted, even when the override answers it", async (t) => {
  withEnv(t, {
    RAG_CLAIM_SOURCE_INHERITANCE: "",
    RAG_QA_ANSWER_VERDICT: "true",
    RAG_QA_VERDICT_OVERRIDE: "supported",
  });
  const write = async (answer) => {
    configureOpenAIProvider({
      completeText: async (_input, { onAttemptStart, onTextDelta } = {}) => {
        onAttemptStart?.();
        for (const piece of answer.match(/[\s\S]{1,6}/g)) onTextDelta?.(piece);
        return answer;
      },
    });

    return captureEvents(() =>
      runWithAnswerDraftChannel(() =>
        writeQaAnswer({
          bundle: { citations: [CITATION], context: `[Source 1]\n${CITATION.excerpt}` },
          query: "How often does the agreement renew?",
          resolvedQuery: "How often does the agreement renew?",
        })
      )
    );
  };
  t.after(() => resetOpenAIProvider());

  const fact = "The agreement renews every 12 months. [Source 1]";
  const plain = await write(`${fact}\n`);
  const overridden = await write(`NOT_IN_EVIDENCE: The documents do not state a renewal fee.\n${fact}\n`);

  // The channel is open: the same sentence without the marker is drafted.
  assert.deepEqual(draftTexts(plain.events), [fact]);
  assert.equal(overridden.result.verdictOverridden, true);
  assert.equal(overridden.result.text, fact);
  assert.deepEqual(draftTexts(overridden.events), []);
  assert.equal(overridden.events.some((event) => event.type === "answer_draft_reset"), false);
});

// The same through the agent: the document loop checks the overridden answer
// like any other, the document_rag step output says verdictOverridden, and
// nothing is drafted. With the override off the step output keeps its shape.
test("through the agent, an overridden reply answers without drafts and its RAG step says so", async (t) => {
  withEnv(t, { RAG_CLAIM_SOURCE_INHERITANCE: "", RAG_QA_ANSWER_VERDICT: "true", RAG_QA_VERDICT_OVERRIDE: "off" });
  t.after(() => resetOpenAIProvider());

  const question = "How often does the agreement renew?";
  const fact = "The agreement renews every 12 months. [Source 1]";
  const reply = `NOT_IN_EVIDENCE: The documents do not state a renewal fee.\n${fact}\n`;

  configureOpenAIProvider({
    completeText: async (_input, { onAttemptStart, onTextDelta } = {}) => {
      onAttemptStart?.();
      for (const piece of reply.match(/[\s\S]{1,6}/g)) onTextDelta?.(piece);
      return reply;
    },
  });

  const ask = () =>
    runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      docIds: ["contract-1"],
      question,
      ragService: buildScopedRagService({
        chat: async ({ question: asked }) => {
          const written = await writeQaAnswer({
            bundle: { citations: [CITATION], context: `[Source 1]\n${CITATION.excerpt}` },
            query: asked,
            resolvedQuery: asked,
          });
          return { ...written, abstained: Boolean(written.abstained), memoryApplied: false, resolvedQuery: asked };
        },
        documents: [{ docId: "contract-1", fileName: CITATION.fileName }],
        sameScope,
        telemetry: createEvalTelemetry(),
      }),
      sessionId: "verdict-override-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => ({ text: "" }),
    });
  const ragStepOutputs = (body) =>
    body.agentTrace
      .filter((step) => step.type === "document_rag" || step.type === "follow_up_retrieval")
      .map((step) => step.output);

  process.env.RAG_QA_VERDICT_OVERRIDE = "off";
  const off = await ask();

  assert.ok(ragStepOutputs(off.body).length > 0);
  for (const output of ragStepOutputs(off.body)) {
    assert.deepEqual(Object.keys(output), ["abstained", "citationCount", "text"]);
    assert.equal(output.abstained, true);
  }
  assert.equal(isAgentVerdictOverridden(off.body), false);

  process.env.RAG_QA_VERDICT_OVERRIDE = "supported";
  const { events, result: on } = await captureEvents(ask);
  const [primary] = ragStepOutputs(on.body);

  assert.deepEqual(primary, { abstained: false, citationCount: 1, text: fact, verdictOverridden: true });
  assert.equal(isAgentVerdictOverridden(on.body), true);
  assert.equal(on.body.agentMode, "document");
  assert.ok(on.body.agentAnswer.includes("renews every 12 months"), on.body.agentAnswer);
  assert.deepEqual(draftTexts(events), []);
});
