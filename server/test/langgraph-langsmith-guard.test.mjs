import "./langgraph-spike/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";

import { createChatPromptTemplate } from "../lib/prompt-template.js";
import {
  LANGSMITH_TRACING_ENABLED_CODE,
  LANGSMITH_TRACING_VARIABLES,
  assertLangSmithTracingDisabled,
  findEnabledLangSmithTracing,
  guardRunnableEntryPoints,
} from "../rag/langgraph/langsmith-guard.js";
import { ArchiveRagChatModel } from "../rag/langgraph/model.js";
import { toLangChainPromptTemplate } from "../rag/langgraph/prompts.js";
import { ArchiveRagRetriever } from "../rag/langgraph/retriever.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every LangSmith tracing variable set to true is refused, in any casing", () => {
  for (const name of LANGSMITH_TRACING_VARIABLES) {
    for (const value of ["true", "TRUE", " True "]) {
      assert.deepEqual(findEnabledLangSmithTracing({ [name]: value }), [name]);
      assert.throws(
        () => assertLangSmithTracingDisabled({ [name]: value }),
        (error) => error.code === LANGSMITH_TRACING_ENABLED_CODE && error.message.includes(name)
      );
    }
  }
});

test("unset, empty and false values pass", () => {
  assert.doesNotThrow(() => assertLangSmithTracingDisabled({}));
  assert.doesNotThrow(() =>
    assertLangSmithTracingDisabled(
      Object.fromEntries(LANGSMITH_TRACING_VARIABLES.map((name, index) =>
        [name, ["", "false", "0", "no", " "][index % 5]]
      ))
    )
  );
  assert.deepEqual(findEnabledLangSmithTracing(undefined), []);
});

test("the error names the variables but carries none of their values", () => {
  const error = (() => {
    try {
      assertLangSmithTracingDisabled({ LANGCHAIN_TRACING_V2: "true", LANGSMITH_TRACING: "true" });
    } catch (caught) {
      return caught;
    }
    return null;
  })();

  assert.ok(error);
  assert.match(error.message, /LANGCHAIN_TRACING_V2, LANGSMITH_TRACING/);
  assert.doesNotMatch(error.message, /\btrue\b/i);
});

// The monolith entry refuses to start before it builds the app: no listener,
// no database connection, a non-zero exit and the guard's message on stderr.
test("node server.js refuses to start with LANGCHAIN_TRACING_V2=true", async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: serverDirectory,
    env: {
      ...process.env,
      LANGCHAIN_TRACING_V2: "true",
      PORT: "0",
      STARTUP_HEALTH_STRICT: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, timedOut: true });
    }, 20_000);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });

  assert.equal(exit.timedOut, false, `server kept running: ${stdout}`);
  assert.notEqual(exit.code, 0);
  assert.match(stderr, /LangSmith tracing must stay off; unset LANGCHAIN_TRACING_V2/);
  assert.doesNotMatch(stdout, /listening/i);
});

// The per-call check has to come before LangChain configures callbacks, and a
// composed runnable configures them -- with the whole chain input -- before
// any of its steps runs. These runnables are built while tracing is off and
// used after a tracing variable was set, which the start-up refusal alone
// would miss. fetch is replaced, so nothing leaves the process; the endpoint
// is a closed local port besides.
const SECRET = "QUOKKA-SECRET-5513";

const withLangSmithSwitchedOnLater = async (action) => {
  const overrides = {
    LANGSMITH_API_KEY: "langgraph-guard-test",
    LANGSMITH_ENDPOINT: "http://127.0.0.1:1",
    LANGSMITH_TRACING: "true",
  };
  const saved = Object.fromEntries(
    Object.keys(overrides).map((name) => [name, Object.hasOwn(process.env, name) ? process.env[name] : undefined])
  );
  const realFetch = globalThis.fetch;
  const requests = [];
  const providerCalls = [];

  configureOpenAIProvider({
    completeText: async (input) => {
      providerCalls.push(input);
      return "ok";
    },
  });

  const template = toLangChainPromptTemplate(
    createChatPromptTemplate([
      ["system", "Answer from the evidence."],
      ["human", "{question}"],
    ])
  );
  const model = new ArchiveRagChatModel();
  const retriever = new ArchiveRagRetriever({ docIds: ["doc-a"] });

  globalThis.fetch = async (url, init = {}) => {
    const body = init.body == null ? "" : Buffer.from(await new Response(init.body).arrayBuffer()).toString("utf8");

    requests.push({ carriesSecret: body.includes(SECRET), url: String(url) });
    return new Response("{}", { headers: { "content-type": "application/json" }, status: 200 });
  };
  const switchOn = () => Object.assign(process.env, overrides);

  // Every trace LangChain queued is handed to fetch before `requests` is read.
  const flush = async () => {
    await awaitAllCallbacks();
    await new LangChainTracer().client.awaitPendingTraceBatches();
  };

  try {
    return await action({ flush, model, providerCalls, requests, retriever, switchOn, template });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    globalThis.fetch = realFetch;
    resetOpenAIProvider();
  }
};

test("adapter runnables and what their own methods compose refuse before LangChain can trace the input", async () => {
  const isRefusal = (error) => error.code === LANGSMITH_TRACING_ENABLED_CODE;
  const LANGSMITH_SETTINGS = ["LANGSMITH_API_KEY", "LANGSMITH_ENDPOINT", "LANGSMITH_TRACING"];
  const before = LANGSMITH_SETTINGS.map((name) => process.env[name]);

  await withLangSmithSwitchedOnLater(async ({ flush, model, providerCalls, requests, retriever, switchOn, template }) => {
    const values = { question: SECRET };
    const passThrough = RunnableLambda.from((value) => value);
    const structured = model.withStructuredOutput(
      { additionalProperties: false, properties: {}, type: "object" },
      { name: "probe" }
    );
    // Composed while tracing is off, as a chain built at start-up would be.
    const built = {
      "model.pipe": [model.pipe(passThrough), SECRET],
      "model.withConfig": [model.withConfig({ runName: "answer" }), SECRET],
      "retriever.pipe": [retriever.pipe(passThrough), SECRET],
      "retriever.withConfig": [retriever.withConfig({ runName: "search" }), SECRET],
      "structured.pipe": [structured.pipe(passThrough), SECRET],
      "template.assign": [template.assign({ extra: passThrough }), values],
      "template.pipe(model)": [template.pipe(model), values],
      "template.pipe(model).pipe(...)": [template.pipe(model).pipe(passThrough), values],
      "template.withConfig": [template.withConfig({ runName: "answer" }), values],
      "template.withFallbacks": [template.withFallbacks([template]), values],
      "template.withRetry": [template.withRetry(), values],
    };

    switchOn();

    for (const [label, [runnable, input]] of Object.entries(built)) {
      await assert.rejects(runnable.invoke(input), isRefusal, `${label}.invoke`);
      await assert.rejects(runnable.stream(input), isRefusal, `${label}.stream`);
      await assert.rejects(runnable.batch([input]), isRefusal, `${label}.batch`);
    }

    for (const [label, call] of [
      ["template.invoke", () => template.invoke(values)],
      ["template.batch", () => template.batch([values])],
      ["template.stream", () => template.stream(values)],
      // Composing while tracing is on refuses at once.
      ["template.pipe", () => template.pipe(model)],
      ["model.withConfig", () => model.withConfig({})],
    ]) {
      await assert.rejects(async () => call(), isRefusal, label);
    }

    // streamEvents returns its stream synchronously, so it refuses so too;
    // streamLog is a generator and refuses on its first step.
    assert.throws(() => template.streamEvents(values, { version: "v2" }), isRefusal);
    await assert.rejects(built["template.pipe(model)"][0].streamLog(values).next(), isRefusal);

    await flush();
    assert.deepEqual(requests, [], "nothing was sent to LangSmith");
    assert.deepEqual(providerCalls, [], "no model call ran");

    // The boundary the header of langsmith-guard.js describes: a composition
    // another runnable starts configures its callbacks before any adapter
    // code runs. The adapter step still refuses, but the chain input has
    // already gone to the tracer -- which is why phase 2's outer entries must
    // check first. It also shows this test would see a leak.
    await assert.rejects(RunnableSequence.from([passThrough, template, model]).invoke(values), isRefusal);
    await flush();
    assert.ok(
      requests.some(({ carriesSecret }) => carriesSecret),
      "a foreign composition's input reaches LangSmith before the adapter refuses"
    );
    assert.deepEqual(providerCalls, []);
  });

  assert.deepEqual(LANGSMITH_SETTINGS.map((name) => process.env[name]), before, "settings restored");
});

test("guardRunnableEntryPoints keeps call shapes and guards each runnable once", async () => {
  const calls = [];
  const runnable = {
    async batch(inputs) {
      calls.push(["batch", this === runnable]);
      return inputs;
    },
    async invoke(input) {
      calls.push(["invoke", this === runnable]);
      return input;
    },
    pipe() {
      return { async invoke(input) { return input; } };
    },
    streamEvents(input) {
      calls.push(["streamEvents", this === runnable]);
      return [input];
    },
    async *streamLog(input) {
      yield input;
    },
  };

  assert.equal(guardRunnableEntryPoints(runnable), runnable);
  const guardedInvoke = runnable.invoke;

  assert.equal(guardRunnableEntryPoints(runnable), runnable);
  assert.equal(runnable.invoke, guardedInvoke, "a second guard wraps nothing again");
  assert.equal(await runnable.invoke("a"), "a");
  assert.deepEqual(await runnable.batch(["b"]), ["b"]);
  assert.deepEqual(runnable.streamEvents("c"), ["c"]);
  assert.deepEqual(await runnable.streamLog("d").next(), { done: false, value: "d" });
  assert.equal(await runnable.pipe().invoke("e"), "e");
  assert.deepEqual(calls, [["invoke", true], ["batch", true], ["streamEvents", true]]);
  assert.equal(guardRunnableEntryPoints(null), null);

  const saved = process.env.LANGCHAIN_TRACING_V2;

  process.env.LANGCHAIN_TRACING_V2 = "true";

  try {
    const isRefusal = (error) => error.code === LANGSMITH_TRACING_ENABLED_CODE;
    // An async entry point rejects instead of throwing synchronously.
    const pending = runnable.invoke("a");

    assert.ok(pending instanceof Promise);
    await assert.rejects(pending, isRefusal);
    assert.throws(() => runnable.pipe(), isRefusal);
    assert.throws(() => runnable.streamEvents("c"), isRefusal);
  } finally {
    if (saved === undefined) delete process.env.LANGCHAIN_TRACING_V2;
    else process.env.LANGCHAIN_TRACING_V2 = saved;
  }

  assert.equal(calls.length, 3, "nothing ran while tracing was on");
});
