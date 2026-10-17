// Must stay the first import: the executor and the trajectory cases below
// load @langchain modules, which read the LangSmith tracing variables.
import "./langgraph-support/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createAppServices } from "../app-services.js";
import { startServiceRole } from "../rag/agent-service/role-server.js";
import * as config from "../rag/config.js";
import { LANGSMITH_TRACING_VARIABLES } from "../rag/langgraph/langsmith-guard.js";

// Phase 6 of docs/adr/0001-langgraph-runtime.md deleted the native graph
// scheduler and the AGENT_RUNTIME dial that selected it. The variable no
// longer selects anything; it is only checked (rag/config.js
// assertAgentRuntimeSupported): unset, empty, whitespace or langgraph
// (trimmed, any case) pass; any other value refuses, so a process asked for
// the rollback never runs LangGraph without saying so. It is checked at
// start-up (server.js and startServiceRole), when the app services are built
// (createAppServices: the monolith, the agent tier, an evaluation runner that
// builds createApp), and at every entry that schedules a graph on LangGraph
// (the custom-Skill stage, the v3 entries and stage, and the executor), which
// also covers evaluation runners that call runAgentRag directly without
// building an app.

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const { AGENT_RUNTIME_REMOVED_CODE, assertAgentRuntimeSupported } = config;

const serverDirectory = fileURLToPath(new URL("..", import.meta.url));
const quietLogger = { error() {}, log() {}, warn() {} };
const SERVICE_KEYS = `runtime-removed:${"r".repeat(48)}`;

// Each accepted value as a label and the environment it is read from.
const ACCEPTED = [
  ["unset", {}],
  ["empty", { AGENT_RUNTIME: "" }],
  ["whitespace", { AGENT_RUNTIME: " \t " }],
  ["langgraph", { AGENT_RUNTIME: "langgraph" }],
  ["LangGraph with a trailing space", { AGENT_RUNTIME: "LangGraph " }],
];

const REFUSED = [
  ["native", { AGENT_RUNTIME: "native" }, /^AGENT_RUNTIME=native was removed \(ADR 0001 phase 6\)/u],
  ["Native, padded", { AGENT_RUNTIME: " Native " }, /^AGENT_RUNTIME=native was removed \(ADR 0001 phase 6\)/u],
  ["lang-graph", { AGENT_RUNTIME: "lang-graph" }, /^AGENT_RUNTIME="lang-graph" is not a runtime/u],
];

const withAgentRuntime = async (value, work) => {
  const saved = Object.hasOwn(process.env, "AGENT_RUNTIME") ? process.env.AGENT_RUNTIME : undefined;

  if (value === undefined) {
    delete process.env.AGENT_RUNTIME;
  } else {
    process.env.AGENT_RUNTIME = value;
  }

  try {
    return await work();
  } finally {
    if (saved === undefined) {
      delete process.env.AGENT_RUNTIME;
    } else {
      process.env.AGENT_RUNTIME = saved;
    }
  }
};

const isRemovedRuntime = (pattern) => (error) => {
  assert.equal(error?.code, AGENT_RUNTIME_REMOVED_CODE);
  assert.match(error.message, pattern);
  assert.match(error.message, /Unset AGENT_RUNTIME or set it to langgraph\.$/u);
  return true;
};

test("the dial is gone: config.js no longer resolves a runtime", () => {
  assert.equal(AGENT_RUNTIME_REMOVED_CODE, "AGENT_RUNTIME_REMOVED");
  assert.equal(Object.hasOwn(config, "getAgentRuntime"), false);
});

test("unset, empty, whitespace and langgraph (any case, trimmed) are accepted", () => {
  for (const [label, env] of ACCEPTED) {
    assert.doesNotThrow(() => assertAgentRuntimeSupported(env), label);
  }

  // A missing environment is the same as one without the variable.
  assert.doesNotThrow(() => assertAgentRuntimeSupported(undefined));
});

test("native and any other value refuse with AGENT_RUNTIME_REMOVED", () => {
  for (const [label, env, pattern] of REFUSED) {
    assert.throws(() => assertAgentRuntimeSupported(env), isRemovedRuntime(pattern), label);
  }
});

test("the check reads process.env by default", () => {
  const saved = Object.hasOwn(process.env, "AGENT_RUNTIME") ? process.env.AGENT_RUNTIME : undefined;

  try {
    process.env.AGENT_RUNTIME = "native";
    assert.throws(() => assertAgentRuntimeSupported(), isRemovedRuntime(/native was removed/u));
    process.env.AGENT_RUNTIME = "langgraph";
    assert.doesNotThrow(() => assertAgentRuntimeSupported());
  } finally {
    if (saved === undefined) {
      delete process.env.AGENT_RUNTIME;
    } else {
      process.env.AGENT_RUNTIME = saved;
    }
  }
});

// startServiceRole checks the environment it is handed before anything else:
// a refused value never reaches the topology check. An accepted one does, and
// the api role without AGENT_SERVICE_URL is refused there, so nothing in this
// test listens or builds an app.
test("startServiceRole refuses a removed AGENT_RUNTIME before the topology check", async () => {
  for (const [label, env, pattern] of REFUSED) {
    await assert.rejects(
      startServiceRole({
        env: { ...env, ARCHIVE_RAG_ROLE: "api", INTERNAL_SERVICE_KEYS: SERVICE_KEYS },
        logger: quietLogger,
        port: 0,
        role: "api",
      }),
      isRemovedRuntime(pattern),
      label
    );
  }

  for (const [label, env] of ACCEPTED) {
    await assert.rejects(
      startServiceRole({
        env: { ...env, ARCHIVE_RAG_ROLE: "api", INTERNAL_SERVICE_KEYS: SERVICE_KEYS },
        logger: quietLogger,
        port: 0,
        role: "api",
      }),
      (error) => {
        assert.notEqual(error?.code, AGENT_RUNTIME_REMOVED_CODE, label);
        assert.match(error.message, /Role api cannot start: .*AGENT_SERVICE_URL/u, label);
        return true;
      },
      label
    );
  }
});

const runServer = async (env) => {
  const childEnv = { ...process.env, ...env, PORT: "0", STARTUP_HEALTH_STRICT: "false" };

  // The LangSmith refusal runs first; keep it out of the way.
  for (const name of LANGSMITH_TRACING_VARIABLES) {
    delete childEnv[name];
  }

  const child = spawn(process.execPath, ["server.js"], {
    cwd: serverDirectory,
    env: childEnv,
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

  return { ...exit, stderr, stdout };
};

// The monolith entry refuses before it builds the app: no listener, no
// database connection, a non-zero exit and the message on stderr.
test("node server.js refuses to start with AGENT_RUNTIME=native or an unknown value", async () => {
  for (const [label, env, pattern] of REFUSED.filter(([label]) => label !== "Native, padded")) {
    const result = await runServer(env);

    assert.equal(result.timedOut, false, `${label}: server kept running: ${result.stdout}`);
    assert.notEqual(result.code, 0, label);
    assert.match(result.stderr, new RegExp(pattern.source.replace(/^\^/u, ""), "u"), label);
    assert.match(result.stderr, /AGENT_RUNTIME_REMOVED/u, label);
    assert.doesNotMatch(result.stdout, /server is running/u, label);
  }
});

// The services every in-process app is built from refuse first: nothing of
// the options is even read (a Proxy that fails on any access stays
// untouched).
test("createAppServices refuses a removed AGENT_RUNTIME before it reads its options", async () => {
  const untouchable = new Proxy(
    {},
    {
      get: (_target, name) => assert.fail(`createAppServices read options.${String(name)}`),
      has: (_target, name) => assert.fail(`createAppServices probed options.${String(name)}`),
    }
  );

  for (const [label, env, pattern] of REFUSED) {
    await withAgentRuntime(env.AGENT_RUNTIME, () =>
      assert.throws(
        () => createAppServices(untouchable, { uploadsDirectory: "/nonexistent" }),
        isRemovedRuntime(pattern),
        label
      )
    );
  }
});

// The executor every guarded graph is scheduled on refuses at its entry,
// before admission: an invalid graph that admission would reject is never
// looked at under a removed value, and is rejected by admission otherwise.
test("the LangGraph executor refuses a removed AGENT_RUNTIME before admission", async () => {
  const { runExecutionGraphOnLangGraph } = await import("../rag/langgraph/run-execution-graph.js");

  for (const [label, env, pattern] of REFUSED) {
    await withAgentRuntime(env.AGENT_RUNTIME, () =>
      assert.rejects(runExecutionGraphOnLangGraph({ graph: null }), isRemovedRuntime(pattern), label)
    );
  }

  for (const [label, env] of ACCEPTED) {
    const result = await withAgentRuntime(env.AGENT_RUNTIME, () =>
      runExecutionGraphOnLangGraph({ graph: null }).then(
        (value) => ({ value }),
        (error) => ({ error })
      )
    );

    assert.notEqual(result.error?.code, AGENT_RUNTIME_REMOVED_CODE, label);
  }
});

// What an evaluation runner does (eval:trajectory, eval:planner,
// eval:recovery-observability, eval:prompt-injection, ...): it calls
// runAgentRag in process, never building an app. A request whose guarded
// custom-Skill DAG or v3 unified graph would be scheduled refuses with the
// removed-runtime error instead of quietly running on LangGraph, so its report
// can never pass for native evidence.
test("an evaluation runner's in-process run of a guarded graph refuses a removed AGENT_RUNTIME", async () => {
  const { runTrajectoryEvaluation } = await import("../evaluation/trajectory-eval.js");
  const { createSkillChainCase } = await import("../evaluation/trajectory/cases/core-flow.js");
  const { createUnifiedGraphEvidenceGatedSkillCase } = await import(
    "../evaluation/trajectory/cases/unified-graph.js"
  );
  const runCase = async (createCase) =>
    (
      await runTrajectoryEvaluation({
        cases: [createCase()],
        createdAt: "2026-10-16T00:00:00.000Z",
        runId: "agent-runtime-removed",
      })
    ).cases[0];
  const caseErrors = (report) =>
    report.checks.filter((check) => check.id === "case_error").map((check) => check.detail);

  for (const [caseLabel, createCase] of [
    ["custom-Skill DAG", createSkillChainCase],
    ["v3 unified graph", createUnifiedGraphEvidenceGatedSkillCase],
  ]) {
    const refused = await withAgentRuntime("native", () => runCase(createCase));

    assert.equal(refused.passed, false, caseLabel);
    assert.equal(caseErrors(refused).length, 1, caseLabel);
    assert.match(caseErrors(refused)[0], /^AGENT_RUNTIME=native was removed \(ADR 0001 phase 6\)/u, caseLabel);

    const accepted = await withAgentRuntime(undefined, () => runCase(createCase));

    assert.deepStrictEqual(caseErrors(accepted), [], caseLabel);
  }
});
