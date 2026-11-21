import assert from "node:assert/strict";
import test from "node:test";

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import chatMCP, { configureChatMcpTransport } from "../chat-mcp.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";

// The web answer path (chat-mcp.js) shares one MCP client between every
// search. Here each connection it opens reaches an in-memory search_web server
// instead of `node mcp-server.js` (useRealSearchServer starts the real one),
// and the model is a stand-in.

const SERPAPI_ERROR_PRELOAD = new URL("./chat-mcp/serpapi-error-answer.mjs", import.meta.url).href;

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

// The child chatMCP starts (`node mcp-server.js`), with `preload` loaded first.
const useRealSearchServer = (t, preload = null) => {
  const transports = [];

  configureChatMcpTransport((parameters) => {
    const transport = new StdioClientTransport({
      ...parameters,
      args: preload ? ["--import", preload, ...parameters.args] : parameters.args,
      stderr: "ignore",
    });

    transports.push(transport);
    return transport;
  });
  t.after(async () => {
    configureChatMcpTransport(null);
    await Promise.all(transports.map((transport) => transport.close()));
  });
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

test("a failed search fails once with its reason and the model never answers it", async (t) => {
  let modelCalls = 0;
  let searches = 0;

  useEnvironment(t, { OPENAI_API_KEY: "test-key" });
  // A thrown error reaches the client as an isError result (McpServer), the
  // result mcp-server.js returns for a missing SERPAPI_KEY or a SerpAPI error.
  useSearchServer(t, async () => {
    searches += 1;
    throw new Error("Web search is not configured: SERPAPI_KEY is not set.");
  });
  useModel(t, async () => {
    modelCalls += 1;
    return "web answer";
  });

  await assert.rejects(chatMCP("anything"), {
    message: "Web search is not configured: SERPAPI_KEY is not set.",
    status: 409,
  });
  assert.equal(searches, 1);
  assert.equal(modelCalls, 0);
});

// The real search server's failures. chatMCP answers only through the model,
// so a rejection means the model was never asked.
test("without SERPAPI_KEY the search server fails the search and says it is not configured", async (t) => {
  // Empty reaches mcp-server.js as unset does.
  useEnvironment(t, { OPENAI_API_KEY: "test-key", SERPAPI_KEY: "" });
  useRealSearchServer(t);
  useModel(t, async () => "web answer");

  await assert.rejects(chatMCP("anything"), {
    message: "Web search is not configured: SERPAPI_KEY is not set.",
    status: 409,
  });
});

test("a SerpAPI error fails the search with SerpAPI's reason, or says SerpAPI failed", async (t) => {
  useEnvironment(t, { OPENAI_API_KEY: "test-key", SERPAPI_KEY: "serp-test-key" });
  useRealSearchServer(t, SERPAPI_ERROR_PRELOAD);
  useModel(t, async () => "web answer");

  // The preload has SerpAPI answer each search with the query as its body.
  for (const [body, reason] of [
    ['{"error":"Your account has run out of searches."}', "Your account has run out of searches."],
    ['{"search_metadata":{"status":"Error"}}', "SerpAPI answered with an error."],
    ["<html><body>502 Bad Gateway</body></html>", "SerpAPI answered with an error."],
  ]) {
    await assert.rejects(chatMCP(body), { message: `Error performing web search: ${reason}`, status: 409 });
  }
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
