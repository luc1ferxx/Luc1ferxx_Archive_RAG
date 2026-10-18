// /chat and /chat/stream bound what one request may carry: the question
// (CHAT_MAX_QUESTION_CHARS, default 8000), the number of docIds
// (CHAT_MAX_DOC_IDS: no default in process, 1000 with a retrieval or agent tier) and the length of each id and of the
// sessionId (CHAT_MAX_ID_CHARS, default 256). A request past one, or with a
// docIds / docId / sessionId of the wrong type, is answered 400 before the
// agent runs; the edge of a split deployment checks the same function.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { AGENT_EDGE_ROUTES } from "../rag/agent-service/edge-router.js";
import { getChatMaxDocIds, getChatMaxIdChars, getChatMaxQuestionChars } from "../rag/config.js";
import { createChatRouter, validateChatRequest } from "../routes/chat.js";
import { parseDocIds } from "../routes/helpers.js";

const ENV_KEYS = [
  "AGENT_CANCEL_ON_DISCONNECT",
  "AGENT_OUTER_PLAN_RUNTIME",
  "AGENT_REQUEST_TIMEOUT_MS",
  "CHAT_MAX_DOC_IDS",
  "CHAT_MAX_ID_CHARS",
  "CHAT_MAX_QUESTION_CHARS",
  "AGENT_SERVICE_URL",
  "RETRIEVAL_SERVICE_URL",
];
let savedEnv;
const unhandledRejections = [];
const recordUnhandledRejection = (reason) => unhandledRejections.push(reason);

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(() => {
  process.off("unhandledRejection", recordUnhandledRejection);

  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// The chat router over a stand-in agent: a request that passes validation is
// recorded and answered 200, so a test sees exactly what reached the agent.
const startChatServer = async () => {
  const answered = [];
  const app = express();

  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    req.accessScope = { userId: "alice", workspaceId: "workspace-a" };
    next();
  });
  app.use(
    createChatRouter({
      buildChatResponse: async (request) => {
        answered.push({
          docIds: request.docIds,
          question: request.question,
          sessionId: request.sessionId,
        });
        return { body: { answer: "ok" }, status: 200 };
      },
    })
  );

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    answered,
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
    post: (body, route = "/chat") =>
      fetch(`${baseUrl}${route}`, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
  };
};

const withChatServer = async (operation) => {
  const server = await startChatServer();

  try {
    await operation(server);
  } finally {
    await server.close();
  }

  assert.deepEqual(unhandledRejections, [], "no request ended in an unhandled rejection");
};

const assertBadRequest = async (response, pattern) => {
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.match((await response.json()).error, pattern);
};

const ids = (count, prefix = "doc") => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

test("the bounds default to 8000 question characters, no docIds limit in process (1000 with a retrieval tier) and 256-character ids", () => {
  assert.equal(getChatMaxQuestionChars(), 8000);
  // A process that retrieves itself has no docIds default (the frontend sends
  // every document of the workspace); with RETRIEVAL_SERVICE_URL the default
  // is the retrieval tier's own 1000. 0 means no limit.
  assert.equal(getChatMaxDocIds(), 0);
  process.env.RETRIEVAL_SERVICE_URL = "http://retrieval.internal:5002";
  assert.equal(getChatMaxDocIds(), 1000);
  delete process.env.RETRIEVAL_SERVICE_URL;
  // An api edge that forwards to an agent tier takes the agent tier's
  // default, so it never forwards a body the agent tier refuses.
  process.env.AGENT_SERVICE_URL = "http://agent.internal:5001";
  assert.equal(getChatMaxDocIds(), 1000);
  process.env.CHAT_MAX_DOC_IDS = "0";
  assert.equal(getChatMaxDocIds(), 0, "0 still means no limit");
  delete process.env.CHAT_MAX_DOC_IDS;
  delete process.env.AGENT_SERVICE_URL;
  assert.equal(getChatMaxDocIds(), 0, "the monolith keeps no default");
  assert.equal(getChatMaxIdChars(), 256);

  process.env.CHAT_MAX_QUESTION_CHARS = "120";
  process.env.CHAT_MAX_DOC_IDS = "3";
  process.env.CHAT_MAX_ID_CHARS = "40";
  assert.equal(getChatMaxQuestionChars(), 120);
  assert.equal(getChatMaxDocIds(), 3);
  assert.equal(getChatMaxIdChars(), 40);

  // A bound must be positive: 0 would refuse every question, so it falls
  // back to the default.
  process.env.CHAT_MAX_QUESTION_CHARS = "0";
  assert.equal(getChatMaxQuestionChars(), 8000);
});

test("a question longer than the bound is refused before the agent runs; the bound itself passes", async () => {
  await withChatServer(async ({ answered, post }) => {
    const atBound = "q".repeat(8000);

    // Measured after trimming, so surrounding whitespace does not count.
    let response = await post({ question: `  ${atBound}\n` });
    assert.equal(response.status, 200);
    assert.equal(answered.at(-1).question, atBound);

    response = await post({ question: `${atBound}q` });
    await assertBadRequest(response, /Question must be at most 8000 characters/);
    assert.equal(answered.length, 1);

    process.env.CHAT_MAX_QUESTION_CHARS = "10";
    await assertBadRequest(await post({ question: "eleven char" }), /at most 10 characters/);
    assert.equal((await post({ question: "ten chars!" })).status, 200);

    // The missing-question message is unchanged.
    await assertBadRequest(await post({}), /Question is required/);
  });
});

test("docIds past the count or id length bound are refused in both forms", async () => {
  await withChatServer(async ({ answered, post }) => {
    // Without a limit set, a large in-process workspace still chats.
    let response = await post({ docIds: ids(1500), question: "What changed?" });
    assert.equal(response.status, 200);
    assert.equal(answered.at(-1).docIds.length, 1500);

    process.env.CHAT_MAX_DOC_IDS = "1000";
    response = await post({ docIds: ids(1000), question: "What changed?" });
    assert.equal(response.status, 200);
    assert.equal(answered.at(-1).docIds.length, 1000);

    await assertBadRequest(
      await post({ docIds: ids(1001), question: "What changed?" }),
      /Too many docIds: the limit is 1000/
    );
    // The frontend's form: one comma-separated string.
    await assertBadRequest(
      await post({ docIds: ids(1001).join(","), question: "What changed?" }),
      /Too many docIds: the limit is 1000/
    );

    process.env.CHAT_MAX_DOC_IDS = "2";
    response = await post({ docIds: "a, b,,", question: "What changed?" });
    assert.equal(response.status, 200);
    assert.deepEqual(answered.at(-1).docIds, ["a", "b"]);
    await assertBadRequest(
      await post({ docIds: "a,b,c", question: "What changed?" }),
      /Too many docIds: the limit is 2/
    );

    const atBound = "d".repeat(256);
    response = await post({ docIds: [atBound], question: "What changed?" });
    assert.equal(response.status, 200);
    assert.deepEqual(answered.at(-1).docIds, [atBound]);
    await assertBadRequest(
      await post({ docIds: [`${atBound}d`], question: "What changed?" }),
      /Each entry of docIds must be at most 256 characters/
    );
    await assertBadRequest(
      await post({ docIds: `a,${atBound}d`, question: "What changed?" }),
      /Each entry of docIds must be at most 256 characters/
    );
    await assertBadRequest(
      await post({ docId: `${atBound}d`, question: "What changed?" }),
      /docId must be at most 256 characters/
    );

    response = await post({ docId: "single", question: "What changed?" });
    assert.equal(response.status, 200);
    assert.deepEqual(answered.at(-1).docIds, ["single"]);
  });
});

test("a docIds entry, docId or sessionId of the wrong type is a 400, not a crash", async () => {
  await withChatServer(async ({ answered, post }) => {
    const before = answered.length;

    // Each of these used to throw (docId.trim / sessionId.trim on a non-string)
    // before the handler's try block: an unhandled rejection, which ends a
    // Node process, and no response.
    await assertBadRequest(
      await post({ docIds: [1], question: "What changed?" }),
      /docIds must be a comma-separated string or a list of strings/
    );
    await assertBadRequest(
      await post({ docIds: ["a", { id: "b" }], question: "What changed?" }),
      /docIds must be a comma-separated string or a list of strings/
    );
    await assertBadRequest(
      await post({ docIds: { 0: "a" }, question: "What changed?" }),
      /docIds must be a comma-separated string or a list of strings/
    );
    await assertBadRequest(await post({ docId: 7, question: "What changed?" }), /docId must be a string/);
    await assertBadRequest(
      await post({ question: "What changed?", sessionId: 42 }),
      /sessionId must be a string/
    );
    await assertBadRequest(
      await post({ question: "What changed?", sessionId: "s".repeat(257) }),
      /sessionId must be at most 256 characters/
    );
    assert.equal(answered.length, before);

    // Absent and null keep meaning "none".
    const response = await post({ docId: null, docIds: null, question: "What changed?", sessionId: null });
    assert.equal(response.status, 200);
    assert.deepEqual(answered.at(-1), { docIds: [], question: "What changed?", sessionId: null });
    assert.equal(
      (await post({ question: "What changed?", sessionId: " session-1 " })).status,
      200
    );
    assert.equal(answered.at(-1).sessionId, "session-1");
  });
});

test("GET /chat and POST /chat/stream apply the same bounds", async () => {
  await withChatServer(async ({ answered, baseUrl, post }) => {
    process.env.CHAT_MAX_QUESTION_CHARS = "20";
    process.env.CHAT_MAX_DOC_IDS = "1";

    await assertBadRequest(
      await fetch(`${baseUrl}/chat?question=${encodeURIComponent("q".repeat(21))}`),
      /at most 20 characters/
    );
    await assertBadRequest(
      await fetch(`${baseUrl}/chat?question=hello&docIds=a,b`),
      /Too many docIds: the limit is 1/
    );
    // Repeated keys arrive as an array.
    await assertBadRequest(
      await fetch(`${baseUrl}/chat?question=hello&docIds=a&docIds=b`),
      /Too many docIds: the limit is 1/
    );
    // An object from bracket notation is not a list of ids.
    await assertBadRequest(
      await fetch(`${baseUrl}/chat?question=hello&docIds[x]=a`),
      /comma-separated string or a list of strings/
    );

    let response = await fetch(`${baseUrl}/chat?question=hello&docIds=a`);
    assert.equal(response.status, 200);
    assert.deepEqual(answered.at(-1).docIds, ["a"]);

    // The stream refuses with a JSON 400 before any event is sent.
    await assertBadRequest(await post({ question: "q".repeat(21) }, "/chat/stream"), /at most 20 characters/);
    await assertBadRequest(
      await post({ docIds: ["a", "b"], question: "hello" }, "/chat/stream"),
      /Too many docIds: the limit is 1/
    );

    response = await post({ docIds: ["a"], question: "hello" }, "/chat/stream");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.match(await response.text(), /event: result/);
  });
});

test("the edge of a split deployment validates /chat with the same function", () => {
  const chatRoutes = AGENT_EDGE_ROUTES.filter((route) => route.path.startsWith("/chat"));

  assert.deepEqual(
    chatRoutes.map((route) => `${route.method} ${route.path}`).sort(),
    ["get /chat", "post /chat", "post /chat/stream"]
  );
  for (const route of chatRoutes) {
    assert.equal(route.validate, validateChatRequest, `${route.method} ${route.path}`);
  }

  // The function answers the response it is handed, as the edge expects.
  const sent = {};
  const res = {
    json(body) {
      sent.body = body;
      return this;
    },
    status(code) {
      sent.status = code;
      return this;
    },
  };

  process.env.CHAT_MAX_DOC_IDS = "1";
  assert.equal(
    validateChatRequest({ body: { docIds: ["a", "b"], question: "hello" }, method: "POST" }, res),
    null
  );
  assert.equal(sent.status, 400);
  assert.match(sent.body.error, /Too many docIds: the limit is 1/);
  assert.deepEqual(validateChatRequest({ body: { docIds: ["a"], question: " hello " }, method: "POST" }, res), {
    docIds: ["a"],
    question: "hello",
  });
});

test("parseDocIds drops entries that are not strings instead of throwing", () => {
  assert.deepEqual(parseDocIds(["a", 1, null, { id: "b" }, " c ", "a"]), ["a", "c"]);
  assert.deepEqual(parseDocIds("a, b,,a"), ["a", "b"]);
  assert.deepEqual(parseDocIds(undefined, " single "), ["single"]);
  assert.deepEqual(parseDocIds(42, 7), []);
});
