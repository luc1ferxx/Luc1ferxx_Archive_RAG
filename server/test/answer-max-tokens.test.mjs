import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { stubModelReplies, useIsolatedAnswerWriterEnvironment } from "./answer-writer-test-helpers.mjs";
import {
  prepareComparisonSourceBundle,
  prepareQASourceBundle,
  writeComparisonAnswer,
  writeQaAnswer,
} from "../rag/answer-writer.js";
import { createAppServices } from "../app-services.js";
import { analyzeComparison } from "../rag/comparison-engine.js";
import { alignComparisonEvidence } from "../rag/evidence-aligner.js";
import {
  assertAnswerGenerationSettings,
  getAnswerMaxTokens,
  getAnswerTemperature,
  getLlmMaxTokensField,
  LLM_MAX_TOKENS_FIELDS,
} from "../rag/config.js";
import { createModelGatewayApp } from "../rag/model-gateway/app.js";
import { resetModelGatewayClient } from "../rag/model-gateway/client.js";
import { MODEL_GATEWAY_PATHS } from "../rag/model-gateway/protocol.js";
import { createModelGatewayQuotas } from "../rag/model-gateway/quotas.js";
import { getModelCallGuardSnapshot } from "../rag/model-call-guard.js";
import { completeTextWithMetadata, resetOpenAIProvider } from "../rag/openai.js";
import { storeSemanticCacheAnswer } from "../rag/semantic-cache.js";
import { SERVICE_TOKEN_HEADER, signServiceToken } from "../rag/service-identity.js";

// RAG_ANSWER_MAX_TOKENS caps the three document answer calls (QA prose, QA
// extractive, comparison); unset, every request is what it was. The limit
// travels in the field RAG_LLM_MAX_TOKENS_FIELD names, directly, streamed and
// through the model gateway, and a reply the limit cut off (finish_reason
// "length") marks the answer answerTruncated.

const SECRET = `${"m".repeat(24)}-max-tokens-secret-0123456789`;

useIsolatedAnswerWriterEnvironment({
  keys: [
    "ARCHIVE_RAG_ROLE",
    "INTERNAL_SERVICE_KEYS",
    "MODEL_GATEWAY_CHAT_UPSTREAMS",
    "MODEL_GATEWAY_EMBEDDING_UPSTREAMS",
    "MODEL_GATEWAY_QUOTA_DAILY_TOKENS",
    "MODEL_GATEWAY_QUOTA_REQUESTS_PER_MINUTE",
    "MODEL_GATEWAY_QUOTA_TOKENS_PER_MINUTE",
    "MODEL_GATEWAY_RERANK_UPSTREAMS",
    "MODEL_GATEWAY_TIMEOUT_MS",
    "MODEL_GATEWAY_URL",
    "OPENAI_API_BASE",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_CHAT_FALLBACK_MODEL",
    "OPENAI_CHAT_MODEL",
    "RAG_ANSWER_MAX_TOKENS",
    "RAG_ANSWER_TEMPERATURE",
    "RAG_COMPARISON_STRUCTURED_OUTPUT",
    "RAG_INJECTION_SCREEN",
    "RAG_LLM_MAX_TOKENS_FIELD",
    "RAG_LLM_REQUEST_TIMEOUT_MS",
    "RAG_OBSERVABILITY_ENABLED",
    "RAG_QA_ANSWER_VERDICT",
    "RAG_QA_EXTRACTIVE_OUTPUT",
    "RAG_SEMANTIC_CACHE",
    "RAG_SHARED_STATE",
    "RAG_STRUCTURED_OUTPUT_ENABLED",
  ],
  prefix: "answer-max-tokens-",
  set: { RAG_OBSERVABILITY_ENABLED: "false", RAG_SHARED_STATE: "memory" },
});

const QUERY = "How many days per week may employees work remotely?";
const POLICY_SENTENCE = "Employees may work remotely 2 days per week with manager approval.";

const qaBundle = () =>
  prepareQASourceBundle({
    results: [
      {
        document: {
          id: "handbook:0",
          pageContent: POLICY_SENTENCE,
          metadata: { chunkIndex: 0, docId: "handbook", fileName: "handbook.pdf", pageNumber: 1 },
        },
        score: 0.9,
      },
    ],
  });

const writeQa = () => writeQaAnswer({ bundle: qaBundle(), query: QUERY, resolvedQuery: QUERY });

const comparison = () => {
  const documents = [
    { docId: "alpha", fileName: "handbook-alpha.pdf", pageContent: POLICY_SENTENCE },
    { docId: "gamma", fileName: "handbook-gamma.pdf", pageContent: "Employees may work remotely 3 days per week with manager approval." },
  ];
  const alignment = alignComparisonEvidence({
    documents: documents.map(({ docId, fileName }) => ({ docId, fileName })),
    perDocumentResults: new Map(
      documents.map(({ docId, fileName, pageContent }) => [
        docId,
        [{ document: { id: `${docId}:0`, metadata: { chunkIndex: 0, docId, fileName, pageNumber: 1 }, pageContent }, score: 0.99 }],
      ])
    ),
    query: "Compare the remote work policy.",
  });

  return { analysis: analyzeComparison({ alignment }), bundle: prepareComparisonSourceBundle({ alignment }) };
};

const writeComparison = () => {
  const { analysis, bundle } = comparison();

  return writeComparisonAnswer({
    analysis,
    bundle,
    query: "Compare the remote work policy.",
    resolvedQuery: "Compare the remote work policy.",
  });
};

const setEnv = (values) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

// A fake OpenAI-compatible backend recording every request body. Chat answers
// `content` with `finishReason`, streamed when the request asks for it;
// `reply(index)` may answer each request differently.
const startUpstream = async (
  t,
  { content: fixedContent = `${POLICY_SENTENCE} [Source 1]`, finishReason: fixedFinishReason = "stop", reply = null } = {}
) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const usage = { completion_tokens: 8, prompt_tokens: 5, total_tokens: 13 };
      const { content, finishReason } = reply
        ? reply(requests.length)
        : { content: fixedContent, finishReason: fixedFinishReason };

      requests.push({ body, path: req.url });

      if (body?.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });

        for (const chunk of [
          { choices: [{ delta: { content }, finish_reason: null, index: 0 }] },
          { choices: [{ delta: {}, finish_reason: finishReason, index: 0 }] },
          { choices: [], usage },
        ]) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }

        res.end("data: [DONE]\n\n");
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: finishReason, index: 0, message: { content, role: "assistant" } }],
          usage,
        })
      );
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
};

// This process calls the backend itself.
const useDirectBackend = (upstream) => {
  resetOpenAIProvider();
  setEnv({
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: upstream.baseUrl,
    OPENAI_CHAT_FALLBACK_MODEL: "",
    OPENAI_CHAT_MODEL: "cap-chat",
    RAG_LLM_REQUEST_TIMEOUT_MS: "5000",
  });
};

// The gateway app on its own port and this process as its calling tier, as in
// model-gateway.test.mjs; both read the same environment.
const startGateway = async (t, upstream) => {
  useDirectBackend(upstream);
  resetModelGatewayClient();
  setEnv({ ARCHIVE_RAG_ROLE: "agent", INTERNAL_SERVICE_KEYS: `k1:${SECRET}` });

  const app = createModelGatewayApp({ quotas: createModelGatewayQuotas() });
  let chatRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === MODEL_GATEWAY_PATHS.chatCompletions) chatRequests += 1;
    app(req, res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  setEnv({ MODEL_GATEWAY_URL: url });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    app.locals.modelGateway.close();
    resetModelGatewayClient();
    resetOpenAIProvider();
  });

  // How many chat calls reached the gateway: a call that skipped it would
  // still reach the same backend.
  return { chatRequests: () => chatRequests, url };
};

test("unset, empty or 0 sends no limit; a whole number of tokens is one; anything else refuses", () => {
  assert.equal(getAnswerMaxTokens(), null);

  for (const none of ["", "   ", "\t", "0", " 0 "]) {
    process.env.RAG_ANSWER_MAX_TOKENS = none;
    assert.equal(getAnswerMaxTokens(), null, JSON.stringify(none));
  }

  for (const [raw, value] of [["1024", 1024], [" 256 ", 256], ["1", 1]]) {
    process.env.RAG_ANSWER_MAX_TOKENS = raw;
    assert.equal(getAnswerMaxTokens(), value, raw);
  }

  for (const invalid of ["-1", "1.5", "abc", "NaN", "Infinity", "9007199254740993"]) {
    process.env.RAG_ANSWER_MAX_TOKENS = invalid;
    assert.throws(
      () => getAnswerMaxTokens(),
      (error) =>
        error.code === "RAG_ANSWER_MAX_TOKENS_INVALID" &&
        /RAG_ANSWER_MAX_TOKENS must be a whole number of tokens/.test(error.message),
      invalid
    );
  }
});

test("a wrong answer-generation setting refuses the start, before the app services read their options", () => {
  const untouchable = new Proxy(
    {},
    {
      get: (_target, name) => assert.fail(`createAppServices read options.${String(name)}`),
      has: (_target, name) => assert.fail(`createAppServices probed options.${String(name)}`),
    }
  );

  for (const [name, value, code] of [
    ["RAG_ANSWER_MAX_TOKENS", "1.5", "RAG_ANSWER_MAX_TOKENS_INVALID"],
    ["RAG_LLM_MAX_TOKENS_FIELD", "num_predict", "RAG_LLM_MAX_TOKENS_FIELD_INVALID"],
    ["RAG_ANSWER_TEMPERATURE", "5", "RAG_ANSWER_TEMPERATURE_INVALID"],
  ]) {
    process.env[name] = value;
    assert.throws(() => assertAnswerGenerationSettings(), { code }, name);
    assert.throws(() => createAppServices(untouchable, { uploadsDirectory: "/nonexistent" }), { code }, name);
    delete process.env[name];
  }

  // Valid or unset, nothing is refused.
  process.env.RAG_ANSWER_MAX_TOKENS = "1024";
  process.env.RAG_LLM_MAX_TOKENS_FIELD = "max_completion_tokens";
  process.env.RAG_ANSWER_TEMPERATURE = "0";
  assert.doesNotThrow(() => assertAnswerGenerationSettings());
  assert.equal(getAnswerTemperature(), 0);
});

test("the model gateway refuses to start with a field it could not send", () => {
  process.env.RAG_LLM_MAX_TOKENS_FIELD = "num_predict";

  assert.throws(() => createModelGatewayApp({ quotas: createModelGatewayQuotas() }), {
    code: "RAG_LLM_MAX_TOKENS_FIELD_INVALID",
  });
});

test("the limit travels in max_tokens unless RAG_LLM_MAX_TOKENS_FIELD names max_completion_tokens", () => {
  assert.deepEqual(LLM_MAX_TOKENS_FIELDS, ["max_tokens", "max_completion_tokens"]);
  assert.equal(getLlmMaxTokensField(), "max_tokens");

  for (const blank of ["", "  "]) {
    process.env.RAG_LLM_MAX_TOKENS_FIELD = blank;
    assert.equal(getLlmMaxTokensField(), "max_tokens");
  }

  process.env.RAG_LLM_MAX_TOKENS_FIELD = " MAX_COMPLETION_TOKENS ";
  assert.equal(getLlmMaxTokensField(), "max_completion_tokens");

  process.env.RAG_LLM_MAX_TOKENS_FIELD = "num_predict";
  assert.throws(() => getLlmMaxTokensField(), {
    code: "RAG_LLM_MAX_TOKENS_FIELD_INVALID",
    message: 'RAG_LLM_MAX_TOKENS_FIELD must be one of max_tokens, max_completion_tokens; got "num_predict".',
  });
});

test("a wrong field refuses a capped call before it enters the model-call guard", async (t) => {
  const upstream = await startUpstream(t);
  const guardKey = `${upstream.baseUrl}|cap-chat`;

  useDirectBackend(upstream);
  process.env.RAG_LLM_MAX_TOKENS_FIELD = "num_predict";

  for (const options of [{ maxTokens: 8 }, { maxTokens: 8, onTextDelta: () => {} }]) {
    await assert.rejects(completeTextWithMetadata("ping", options), { code: "RAG_LLM_MAX_TOKENS_FIELD_INVALID" });
  }

  // No slot was taken and the circuit breaker counted nothing: the endpoint's
  // guard does not even exist yet.
  assert.equal(getModelCallGuardSnapshot(guardKey), null);
  assert.equal(upstream.requests.length, 0);

  // An uncapped call never reads the field; it creates the guard the capped
  // calls never reached.
  await completeTextWithMetadata("ping");
  assert.notEqual(getModelCallGuardSnapshot(guardKey), null);
  assert.equal(upstream.requests.length, 1);
});

test("the three answer calls carry the limit only when it is set, and an invalid one refuses before any call", async () => {
  const proseReply = `${POLICY_SENTENCE} [Source 1]`;
  const unset = stubModelReplies([proseReply]);
  const unsetAnswer = await writeQa();

  assert.equal("maxTokens" in unset[0].options, false);
  // A stand-in provider reports no finish reason, so nothing is marked.
  assert.equal("answerTruncated" in unsetAnswer, false);

  process.env.RAG_ANSWER_MAX_TOKENS = "1024";
  const capped = stubModelReplies([proseReply]);
  const cappedAnswer = await writeQa();

  assert.equal(capped[0].options.maxTokens, 1024);
  // The setting changes the request, not what is done with the reply.
  assert.equal(cappedAnswer.text, unsetAnswer.text);
  assert.equal("answerTruncated" in cappedAnswer, false);

  // The extractive attempt and its prose fallback.
  process.env.RAG_QA_EXTRACTIVE_OUTPUT = "true";
  const extractive = stubModelReplies(["not json", proseReply]);

  await writeQa();
  assert.deepEqual(extractive.map((call) => call.options.maxTokens), [1024, 1024]);
  delete process.env.RAG_QA_EXTRACTIVE_OUTPUT;

  // The comparison call, with and without structured output.
  for (const structured of [false, true]) {
    if (structured) process.env.RAG_COMPARISON_STRUCTURED_OUTPUT = "true";

    const calls = stubModelReplies(["Differences:\n- alpha says 2 days [Source 1]"]);

    await writeComparison();
    assert.equal(calls[0].options.maxTokens, 1024, `structured ${structured}`);
  }

  delete process.env.RAG_ANSWER_MAX_TOKENS;
  const comparisonUnset = stubModelReplies(["Differences:\n- alpha says 2 days [Source 1]"]);

  await writeComparison();
  assert.equal("maxTokens" in comparisonUnset[0].options, false);

  process.env.RAG_ANSWER_MAX_TOKENS = "1.5";
  const refused = stubModelReplies([proseReply]);

  await assert.rejects(writeQa(), /RAG_ANSWER_MAX_TOKENS must be a whole number of tokens/);
  assert.equal(refused.length, 0);
});

test("the chat request carries a limit only when given one, in the field RAG_LLM_MAX_TOKENS_FIELD names, streamed or not", async (t) => {
  const upstream = await startUpstream(t);

  useDirectBackend(upstream);

  await completeTextWithMetadata("ping");
  await completeTextWithMetadata("ping", { maxTokens: 64 });
  await completeTextWithMetadata("ping", { maxTokens: 64, onTextDelta: () => {} });
  // Not a positive whole number: nothing is sent.
  for (const maxTokens of [0, -5, 1.5, "64", null]) {
    await completeTextWithMetadata("ping", { maxTokens });
  }

  process.env.RAG_LLM_MAX_TOKENS_FIELD = "max_completion_tokens";
  await completeTextWithMetadata("ping", { maxTokens: 64 });
  await completeTextWithMetadata("ping", { maxTokens: 64, onTextDelta: () => {} });
  await completeTextWithMetadata("ping");

  const limits = upstream.requests.map(({ body }) => ({
    max_completion_tokens: body.max_completion_tokens,
    max_tokens: body.max_tokens,
    stream: body.stream === true,
  }));

  assert.deepEqual(limits, [
    { max_completion_tokens: undefined, max_tokens: undefined, stream: false },
    { max_completion_tokens: undefined, max_tokens: 64, stream: false },
    { max_completion_tokens: undefined, max_tokens: 64, stream: true },
    ...Array.from({ length: 5 }, () => ({ max_completion_tokens: undefined, max_tokens: undefined, stream: false })),
    { max_completion_tokens: 64, max_tokens: undefined, stream: false },
    { max_completion_tokens: 64, max_tokens: undefined, stream: true },
    { max_completion_tokens: undefined, max_tokens: undefined, stream: false },
  ]);
  // A request without a limit is the one it always was.
  assert.deepEqual(Object.keys(upstream.requests[0].body).sort(), ["messages", "model"]);
});

test("the finish reason of the reply a call returns is heard once, and the returned shape is unchanged", async (t) => {
  const upstream = await startUpstream(t, { content: "Employees may work", finishReason: "length" });

  useDirectBackend(upstream);

  const reasons = [];
  const plain = await completeTextWithMetadata("ping", { maxTokens: 4, onFinishReason: (reason) => reasons.push(reason) });
  const streamed = await completeTextWithMetadata("ping", {
    maxTokens: 4,
    onFinishReason: (reason) => reasons.push(reason),
    onTextDelta: () => {},
  });

  assert.deepEqual(reasons, ["length", "length"]);
  assert.equal(plain.text, "Employees may work");
  assert.equal(streamed.text, "Employees may work");
  assert.deepEqual(Object.keys(plain).sort(), ["modelRoute", "text"]);
  // A reply with text is never retried, cut or not.
  assert.equal(upstream.requests.length, 2);
});

test("an empty reply the limit cut is returned once, not retried like an empty finished one", async (t) => {
  const cut = await startUpstream(t, { content: "", finishReason: "length" });

  useDirectBackend(cut);

  const reasons = [];
  const onFinishReason = (reason) => reasons.push(reason);

  assert.equal((await completeTextWithMetadata("ping", { maxTokens: 4, onFinishReason })).text, "");
  assert.equal((await completeTextWithMetadata("ping", { maxTokens: 4, onFinishReason, onTextDelta: () => {} })).text, "");
  // The same limit would cut a second try again: one request per call.
  assert.equal(cut.requests.length, 2);
  assert.deepEqual(reasons, ["length", "length"]);

  // Control: an empty reply that finished is retried once.
  const finished = await startUpstream(t, { content: "", finishReason: "stop" });

  useDirectBackend(finished);
  assert.equal((await completeTextWithMetadata("ping", { maxTokens: 4 })).text, "");
  assert.equal(finished.requests.length, 2);
});

test("an empty reply the limit cut is an abstention, not the canned answer with every citation", async (t) => {
  const upstream = await startUpstream(t, { content: "", finishReason: "length" });

  useDirectBackend(upstream);
  process.env.RAG_ANSWER_MAX_TOKENS = "16";

  const answer = await writeQa();

  assert.equal(upstream.requests.length, 1);
  assert.equal(answer.abstained, true);
  assert.equal(answer.abstainSource, "output_limit");
  assert.deepEqual(answer.citations, []);
  assert.equal(answer.answerTruncated, true);
  assert.equal(answer.trace.answerTruncated, true);
});

test("a cut extractive attempt keeps the answer marked when the prose fallback writes it", async (t) => {
  const upstream = await startUpstream(t, {
    reply: (index) =>
      index === 0
        ? { content: '{"answer": "2 days", "quotes": [{"source": 1, "quote": "Employees may', finishReason: "length" }
        : { content: `${POLICY_SENTENCE} [Source 1]`, finishReason: "stop" },
  });

  useDirectBackend(upstream);
  process.env.RAG_ANSWER_MAX_TOKENS = "24";
  process.env.RAG_QA_EXTRACTIVE_OUTPUT = "true";

  const answer = await writeQa();

  assert.deepEqual(upstream.requests.map(({ body }) => body.max_tokens), [24, 24]);
  assert.equal(answer.trace.qaStructuredOutput.fallback, "prose");
  assert.equal(answer.text, `${POLICY_SENTENCE} [Source 1]`);
  assert.equal(answer.answerTruncated, true);
});

test("an answer the limit cut off is marked answerTruncated, on the answer and in its trace", async (t) => {
  const cutReply = "Employees may work remotely 2 days per week with";
  const upstream = await startUpstream(t, { content: cutReply, finishReason: "length" });

  useDirectBackend(upstream);
  process.env.RAG_ANSWER_MAX_TOKENS = "12";

  const cut = await writeQa();

  assert.equal(upstream.requests[0].body.max_tokens, 12);
  assert.equal(cut.answerTruncated, true);
  assert.equal(cut.trace.answerTruncated, true);
  // The reply is kept as the model wrote it; the mark says it was cut.
  assert.equal(cut.text, cutReply);
});

test("an answer that finished carries no mark, so it keeps its shape", async (t) => {
  const upstream = await startUpstream(t);

  useDirectBackend(upstream);
  process.env.RAG_ANSWER_MAX_TOKENS = "1024";

  const finished = await writeQa();

  assert.equal(upstream.requests[0].body.max_tokens, 1024);
  assert.equal("answerTruncated" in finished, false);
  assert.equal("trace" in finished, false);
});

test("a comparison reply cut off is marked even when the template replaced it", async (t) => {
  const upstream = await startUpstream(t, { content: "Differences:\n- alpha says", finishReason: "length" });

  useDirectBackend(upstream);
  process.env.RAG_ANSWER_MAX_TOKENS = "6";

  const answer = await writeComparison();

  assert.equal(upstream.requests[0].body.max_tokens, 6);
  assert.equal(answer.answerTruncated, true);
  assert.equal(answer.trace.answerTruncated, true);
  // The cut reply did not pass the gate; what replaced it says so.
  assert.ok(answer.trace.modelRejectReason);
});

test("through the model gateway the limit reaches the backend in the gateway's field, and the cut-off comes back", async (t) => {
  const upstream = await startUpstream(t, { content: "Employees may work", finishReason: "length" });
  const gateway = await startGateway(t, upstream);

  process.env.RAG_LLM_MAX_TOKENS_FIELD = "max_completion_tokens";

  const reasons = [];
  const onFinishReason = (reason) => reasons.push(reason);

  await completeTextWithMetadata("ping", { maxTokens: 32, onFinishReason });
  await completeTextWithMetadata("ping", { maxTokens: 32, onFinishReason, onTextDelta: () => {} });
  await completeTextWithMetadata("ping");

  assert.deepEqual(reasons, ["length", "length"]);
  // Every call went through the gateway, not straight to the backend.
  assert.equal(gateway.chatRequests(), 3);
  assert.equal(upstream.requests.length, 3);
  assert.equal(upstream.requests[0].body.max_completion_tokens, 32);
  assert.equal("max_tokens" in upstream.requests[0].body, false);
  assert.equal(upstream.requests[1].body.max_completion_tokens, 32);
  assert.equal(upstream.requests[1].body.stream, true);
  assert.equal("max_completion_tokens" in upstream.requests[2].body, false);
  assert.equal("max_tokens" in upstream.requests[2].body, false);
});

test("the gateway refuses a limit it cannot send instead of dropping it", async (t) => {
  const upstream = await startUpstream(t);
  const gateway = await startGateway(t, upstream);
  const post = (body) =>
    fetch(`${gateway.url}${MODEL_GATEWAY_PATHS.chatCompletions}`, {
      body: JSON.stringify({ messages: [{ content: "ping", role: "user" }], ...body }),
      headers: {
        "content-type": "application/json",
        [SERVICE_TOKEN_HEADER]: signServiceToken({
          accessScope: { authenticated: true, userId: "alice", workspaceId: "ws-a" },
          audience: "model-gateway",
          issuer: "agent",
        }),
      },
      method: "POST",
    });

  for (const maxTokens of [0, -1, 1.5, "32", true, {}]) {
    const response = await post({ max_tokens: maxTokens });

    assert.equal(response.status, 400, JSON.stringify(maxTokens));
  }

  assert.equal(upstream.requests.length, 0);

  // No limit, or null, is no limit.
  assert.equal((await post({})).status, 200);
  assert.equal((await post({ max_tokens: null })).status, 200);
  assert.equal((await post({ max_tokens: 32 })).status, 200);
  assert.deepEqual(
    upstream.requests.map(({ body }) => body.max_tokens),
    [undefined, undefined, 32]
  );
});

test("the semantic cache does not keep an answer the limit cut off", () => {
  process.env.RAG_SEMANTIC_CACHE = "on";

  assert.deepEqual(
    storeSemanticCacheAnswer({ pending: {} }, { answerTruncated: true, citations: [], text: "Employees may work" }),
    { stored: false, storeSkipReason: "answer_truncated" }
  );
});
