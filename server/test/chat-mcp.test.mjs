import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import chatMCP, { configureChatMcpTransport } from "../chat-mcp.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";

// The web answer path (chat-mcp.js) shares one MCP client between every
// search. Here each connection it opens reaches an in-memory search_web server
// instead of `node mcp-server.js`, and the model is a stand-in.

const createDeferred = () => {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

const useEnvironment = (t, values) => {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));

  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
};

// `search(query)` answers search_web; the result keeps, per connection, the
// parameters the child process would have been started with and the server.
const useSearchServer = (t, search) => {
  const connections = [];

  configureChatMcpTransport((parameters) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "search", version: "1.0.0" });

    server.registerTool(
      "search_web",
      { inputSchema: { num: z.number().optional(), query: z.string() } },
      async ({ query }) => ({ content: [{ text: await search(query), type: "text" }] })
    );
    connections.push({ parameters, server });
    void server.connect(serverSide);

    return clientSide;
  });
  t.after(() => configureChatMcpTransport(null));

  return connections;
};

const useModel = (t, completeText) => {
  configureOpenAIProvider({ completeText });
  t.after(resetOpenAIProvider);
};

test("a search whose own model call fails leaves the shared client to the searches still in flight", async (t) => {
  const slowSearchStarted = createDeferred();
  const slowSearchAnswers = createDeferred();

  useEnvironment(t, { OPENAI_API_KEY: "test-key" });
  const connections = useSearchServer(t, async (query) => {
    if (query === "slow") {
      slowSearchStarted.resolve();
      await slowSearchAnswers.promise;
    }

    return `results for ${query}`;
  });
  useModel(t, async (prompt) => {
    if (prompt.includes("results for fast")) {
      throw Object.assign(new Error("The model answered 503."), { status: 503 });
    }

    return "web answer";
  });

  const slow = chatMCP("slow");

  await slowSearchStarted.promise;
  await assert.rejects(chatMCP("fast"), /answered 503/);
  slowSearchAnswers.resolve();

  assert.deepEqual(await slow, { text: "web answer" });
  assert.equal(connections.length, 1);
});

test("a search in flight when its connection closes is sent again on a new one", async (t) => {
  const firstSearchStarted = createDeferred();
  let searches = 0;

  useEnvironment(t, { OPENAI_API_KEY: "test-key" });
  const connections = useSearchServer(t, async (query) => {
    searches += 1;

    if (searches === 1) {
      firstSearchStarted.resolve();
      await new Promise(() => {});
    }

    return `results for ${query}`;
  });
  useModel(t, async () => "web answer");

  const search = chatMCP("question");

  await firstSearchStarted.promise;
  // The child process exits.
  await connections[0].server.close();

  assert.deepEqual(await search, { text: "web answer" });
  assert.equal(connections.length, 2);
});

test("the search server's child gets SERPAPI_KEY and no other secret of this process", async (t) => {
  useEnvironment(t, { OPENAI_API_KEY: "sk-unrelated-secret", SERPAPI_KEY: "serp-test-key" });
  const connections = useSearchServer(t, async (query) => `results for ${query}`);
  useModel(t, async () => "web answer");

  assert.deepEqual(await chatMCP("anything"), { text: "web answer" });
  // The SDK adds only its own safe defaults (PATH, HOME, ...) to this.
  assert.deepEqual(
    connections.map(({ parameters }) => parameters.env),
    [{ SERPAPI_KEY: "serp-test-key" }]
  );
});
