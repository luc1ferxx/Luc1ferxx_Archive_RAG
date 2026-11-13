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

// The agent has one runtime, LangGraph (docs/adr/0001-langgraph-runtime.md).
// Phase 6 deleted the native graph scheduler and the AGENT_RUNTIME dial that
// selected it; phase 7 deleted the native outer loop and the
// AGENT_OUTER_PLAN_RUNTIME dial that selected it; phase 8 deleted the
// sequential Skill chain and the AGENT_SKILL_GRAPH_ROLLOUT values that
// selected it (`off`, `shadow`). None of the three variables selects anything
// any more; all are only checked (rag/config.js assertAgentRuntimeSupported):
// unset, empty, whitespace or the one value left (langgraph for the two
// runtime dials, guarded for the rollout; trimmed, any case) pass; any other
// value refuses, so a process asked for something that was removed never runs
// LangGraph without saying so. They are checked at start-up (server.js and
// startServiceRole), when the app services are built (createAppServices: the
// monolith, the agent tier, an evaluation runner that builds createApp), and
// at every entry that schedules on LangGraph (the outer plan's entry, the
// custom-Skill stage, the v3 entries and stage, and the executor), which also
// covers evaluation runners that call runAgentRag directly without building
// an app.

process.env.VECTOR_STORE_PROVIDER = "local";
process.env.RAG_HYBRID_ENABLED = "false";

const {
  AGENT_OUTER_PLAN_RUNTIME_REMOVED_CODE,
  AGENT_RUNTIME_REMOVED_CODE,
  AGENT_SKILL_GRAPH_ROLLOUT_REMOVED_CODE,
  assertAgentRuntimeSupported,
} = config;

const serverDirectory = fileURLToPath(new URL("..", import.meta.url));
const quietLogger = { error() {}, log() {}, warn() {} };
const SERVICE_KEYS = `runtime-removed:${"r".repeat(48)}`;

// The three removed dials: the variable, its error code, the ADR phase that
// removed it, the one value it still accepts, the values that selected what
// was deleted, what kind of thing it chose, a value that was never one, and
// the getter that is gone.
const DIALS = [
  {
    accepted: "langgraph",
    code: AGENT_RUNTIME_REMOVED_CODE,
    getter: "getAgentRuntime",
    kind: "a runtime",
    name: "AGENT_RUNTIME",
    phase: 6,
    removedValues: ["native"],
    typo: "lang-graph",
  },
  {
    accepted: "langgraph",
    code: AGENT_OUTER_PLAN_RUNTIME_REMOVED_CODE,
    getter: "getAgentOuterPlanRuntime",
    kind: "a runtime",
    name: "AGENT_OUTER_PLAN_RUNTIME",
    phase: 7,
    removedValues: ["native"],
    typo: "pregel",
  },
  {
    accepted: "guarded",
    code: AGENT_SKILL_GRAPH_ROLLOUT_REMOVED_CODE,
    getter: "getAgentSkillGraphRollout",
    kind: "a rollout mode",
    name: "AGENT_SKILL_GRAPH_ROLLOUT",
    phase: 8,
    removedValues: ["off", "shadow"],
    typo: "gaurded",
  },
];
const DIAL_NAMES = DIALS.map(({ name }) => name);
const capitalize = (value) => `${value[0].toUpperCase()}${value.slice(1)}`;

// Each accepted value as a label and the environment it is read from.
const acceptedFor = ({ accepted, name }) => [
  ["unset", {}],
  ["empty", { [name]: "" }],
  ["whitespace", { [name]: " \t " }],
  [accepted, { [name]: accepted }],
  [`${capitalize(accepted)} with a trailing space`, { [name]: `${capitalize(accepted)} ` }],
];

const removedPattern = ({ name, phase }, value) =>
  new RegExp(`^${name}=${value} was removed \\(ADR 0001 phase ${phase}\\)`, "u");

const refusedFor = (dial) => {
  const { kind, name, removedValues, typo } = dial;

  return [
    ...removedValues.flatMap((value) => [
      [value, { [name]: value }, removedPattern(dial, value)],
      [`${capitalize(value)}, padded`, { [name]: ` ${capitalize(value)} ` }, removedPattern(dial, value)],
    ]),
    [typo, { [name]: typo }, new RegExp(`^${name}="${typo}" is not ${kind}`, "u")],
  ];
};

// The first removed value of a dial, for the cases that need only one.
const removedEnv = ({ name, removedValues }) => ({ [name]: removedValues[0] });
const firstRemovedPattern = (dial) => removedPattern(dial, dial.removedValues[0]);

// Runs `work` with exactly `env` for the three dials: a dial `env` does not
// name is unset, whatever the ambient environment holds.
const withDials = async (env, work) => {
  const saved = Object.fromEntries(
    DIAL_NAMES.map((name) => [name, Object.hasOwn(process.env, name) ? process.env[name] : undefined])
  );
  const apply = (values) => {
    for (const name of DIAL_NAMES) {
      if (values[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = values[name];
      }
    }
  };

  apply(env);

  try {
    return await work();
  } finally {
    apply(saved);
  }
};

const isRemovedRuntime = ({ accepted, code, name }, pattern) => (error) => {
  assert.equal(error?.code, code);
  assert.match(error.message, pattern);
  assert.match(error.message, new RegExp(`Unset ${name} or set it to ${accepted}\\.$`, "u"));
  return true;
};

const isNoRemovedRuntimeError = (error) =>
  DIALS.every(({ code }) => error?.code !== code);

test("the dials are gone: config.js resolves no runtime and no Skill rollout, and each removed value has its own code", () => {
  assert.equal(AGENT_RUNTIME_REMOVED_CODE, "AGENT_RUNTIME_REMOVED");
  assert.equal(AGENT_OUTER_PLAN_RUNTIME_REMOVED_CODE, "AGENT_OUTER_PLAN_RUNTIME_REMOVED");
  assert.equal(AGENT_SKILL_GRAPH_ROLLOUT_REMOVED_CODE, "AGENT_SKILL_GRAPH_ROLLOUT_REMOVED");

  for (const { getter } of DIALS) {
    assert.equal(Object.hasOwn(config, getter), false, getter);
  }
});

for (const dial of DIALS) {
  const { code, name } = dial;
  const ACCEPTED = acceptedFor(dial);
  const REFUSED = refusedFor(dial);

  test(`${name}: unset, empty, whitespace and ${dial.accepted} (any case, trimmed) are accepted`, () => {
    for (const [label, env] of ACCEPTED) {
      assert.doesNotThrow(() => assertAgentRuntimeSupported(env), label);
    }
  });

  test(`${name}: ${dial.removedValues.join(", ")} and any other value refuse with ${code}`, () => {
    for (const [label, env, pattern] of REFUSED) {
      assert.throws(() => assertAgentRuntimeSupported(env), isRemovedRuntime(dial, pattern), label);
    }
  });

  test(`${name}: the check reads process.env by default`, async () => {
    await withDials(removedEnv(dial), () => {
      assert.throws(() => assertAgentRuntimeSupported(), isRemovedRuntime(dial, firstRemovedPattern(dial)));
      // A missing environment argument is process.env.
      assert.throws(
        () => assertAgentRuntimeSupported(undefined),
        isRemovedRuntime(dial, firstRemovedPattern(dial))
      );
    });
    await withDials({ [name]: dial.accepted }, () => {
      assert.doesNotThrow(() => assertAgentRuntimeSupported());
    });
  });

  // startServiceRole checks the environment it is handed before anything
  // else: a refused value never reaches the topology check. An accepted one
  // does, and the api role without AGENT_SERVICE_URL is refused there, so
  // nothing in this test listens or builds an app.
  test(`${name}: startServiceRole refuses a removed value before the topology check`, async () => {
    for (const [label, env, pattern] of REFUSED) {
      await assert.rejects(
        startServiceRole({
          env: { ...env, ARCHIVE_RAG_ROLE: "api", INTERNAL_SERVICE_KEYS: SERVICE_KEYS },
          logger: quietLogger,
          port: 0,
          role: "api",
        }),
        isRemovedRuntime(dial, pattern),
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
          assert.ok(isNoRemovedRuntimeError(error), label);
          assert.match(error.message, /Role api cannot start: .*AGENT_SERVICE_URL/u, label);
          return true;
        },
        label
      );
    }
  });
}

test("several dials set to a removed value: one of them names the refusal, and accepted values do not excuse another", () => {
  const allAccepted = Object.fromEntries(DIALS.map(({ accepted, name }) => [name, accepted]));
  const allRemoved = Object.fromEntries(DIALS.map((dial) => Object.entries(removedEnv(dial))[0]));

  assert.throws(
    () => assertAgentRuntimeSupported(allRemoved),
    (error) => DIALS.some(({ code }) => error?.code === code)
  );

  // Every other dial holds its accepted value; the removed one still refuses.
  for (const dial of DIALS) {
    assert.throws(
      () => assertAgentRuntimeSupported({ ...allAccepted, ...removedEnv(dial) }),
      isRemovedRuntime(dial, firstRemovedPattern(dial)),
      dial.name
    );
  }

  assert.doesNotThrow(() => assertAgentRuntimeSupported(allAccepted));
  assert.doesNotThrow(() =>
    assertAgentRuntimeSupported({
      AGENT_OUTER_PLAN_RUNTIME: " LangGraph ",
      AGENT_RUNTIME: "",
      AGENT_SKILL_GRAPH_ROLLOUT: " Guarded ",
    })
  );
});

const runServer = async (env) => {
  const childEnv = { ...process.env, PORT: "0", STARTUP_HEALTH_STRICT: "false" };

  // The LangSmith refusal runs first; keep it out of the way. Of the three
  // dials only the one under test is set.
  for (const name of [...LANGSMITH_TRACING_VARIABLES, ...DIAL_NAMES]) {
    delete childEnv[name];
  }

  Object.assign(childEnv, env);

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
test("node server.js refuses to start with a removed value of any dial", async () => {
  for (const dial of DIALS) {
    for (const [label, env, pattern] of refusedFor(dial).filter(([label]) => !label.endsWith(", padded"))) {
      const result = await runServer(env);
      const caseLabel = `${dial.name} ${label}`;

      assert.equal(result.timedOut, false, `${caseLabel}: server kept running: ${result.stdout}`);
      assert.notEqual(result.code, 0, caseLabel);
      assert.match(result.stderr, new RegExp(pattern.source.replace(/^\^/u, ""), "u"), caseLabel);
      assert.match(result.stderr, new RegExp(dial.code, "u"), caseLabel);
      assert.doesNotMatch(result.stdout, /server is running/u, caseLabel);
    }
  }
});

// The services every in-process app is built from refuse first: nothing of
// the options is even read (a Proxy that fails on any access stays
// untouched).
test("createAppServices refuses a removed value of any dial before it reads its options", async () => {
  const untouchable = new Proxy(
    {},
    {
      get: (_target, name) => assert.fail(`createAppServices read options.${String(name)}`),
      has: (_target, name) => assert.fail(`createAppServices probed options.${String(name)}`),
    }
  );

  for (const dial of DIALS) {
    for (const [label, env, pattern] of refusedFor(dial)) {
      await withDials(env, () =>
        assert.throws(
          () => createAppServices(untouchable, { uploadsDirectory: "/nonexistent" }),
          isRemovedRuntime(dial, pattern),
          `${dial.name} ${label}`
        )
      );
    }
  }
});

// The executor every guarded graph is scheduled on refuses at its entry,
// before admission: an invalid graph that admission would reject is never
// looked at under a removed value, and is rejected by admission otherwise.
test("the LangGraph executor refuses a removed value of any dial before admission", async () => {
  const { runExecutionGraphOnLangGraph } = await import("../rag/langgraph/run-execution-graph.js");

  for (const dial of DIALS) {
    for (const [label, env, pattern] of refusedFor(dial)) {
      await withDials(env, () =>
        assert.rejects(
          runExecutionGraphOnLangGraph({ graph: null }),
          isRemovedRuntime(dial, pattern),
          `${dial.name} ${label}`
        )
      );
    }

    for (const [label, env] of acceptedFor(dial)) {
      const result = await withDials(env, () =>
        runExecutionGraphOnLangGraph({ graph: null }).then(
          (value) => ({ value }),
          (error) => ({ error })
        )
      );

      assert.ok(isNoRemovedRuntimeError(result.error), `${dial.name} ${label}`);
    }
  }
});

// The outer plan's entry, which every request that reaches the plan passes
// since phase 7, refuses before it validates the plan or builds a stage: the
// options are never read under a removed value, and an accepted value reaches
// the plan's own validation (which rejects the unknown step).
test("the outer plan's entry refuses a removed value of any dial before it reads the plan", async () => {
  const { runAgentExecutionPlan } = await import("../rag/agent-execution-plan-runner.js");
  const untouchable = new Proxy(
    {},
    {
      get: (_target, name) => assert.fail(`the outer plan read options.${String(name)}`),
      has: (_target, name) => assert.fail(`the outer plan probed options.${String(name)}`),
    }
  );

  for (const dial of DIALS) {
    for (const [label, env, pattern] of refusedFor(dial)) {
      await withDials(env, () =>
        assert.rejects(
          runAgentExecutionPlan(untouchable),
          isRemovedRuntime(dial, pattern),
          `${dial.name} ${label}`
        )
      );
    }

    for (const [label, env] of acceptedFor(dial)) {
      await withDials(env, () =>
        assert.rejects(
          runAgentExecutionPlan({ executionPlan: [{ id: "shell_tool" }], selectedSkills: [] }),
          (error) => {
            assert.ok(isNoRemovedRuntimeError(error), `${dial.name} ${label}`);
            assert.match(error.message, /unknown execution step shell_tool/u, `${dial.name} ${label}`);
            return true;
          }
        )
      );
    }
  }
});

// What an evaluation runner does (eval:trajectory, eval:planner,
// eval:recovery-observability, eval:prompt-injection, ...): it calls
// runAgentRag in process, never building an app. Since phase 7 every request
// that reaches the outer plan is scheduled on LangGraph, so a document
// question refuses with the removed-value error exactly as a custom-Skill
// DAG or a v3 unified graph does, instead of quietly running on LangGraph:
// its report can never pass for native or sequential-chain evidence.
test("an evaluation runner's in-process run refuses a removed value of any dial", async () => {
  const { runTrajectoryEvaluation } = await import("../evaluation/trajectory-eval.js");
  const { createFollowUpCase, createSkillChainCase } = await import(
    "../evaluation/trajectory/cases/core-flow.js"
  );
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
    ["document question", createFollowUpCase],
    ["custom-Skill DAG", createSkillChainCase],
    ["v3 unified graph", createUnifiedGraphEvidenceGatedSkillCase],
  ]) {
    for (const dial of DIALS) {
      for (const value of dial.removedValues) {
        const label = `${caseLabel} under ${dial.name}=${value}`;
        const refused = await withDials({ [dial.name]: value }, () => runCase(createCase));

        assert.equal(refused.passed, false, label);
        assert.equal(caseErrors(refused).length, 1, label);
        assert.match(caseErrors(refused)[0], removedPattern(dial, value), label);
      }
    }

    const accepted = await withDials({}, () => runCase(createCase));

    assert.deepStrictEqual(caseErrors(accepted), [], caseLabel);
  }
});
