// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { isDeepStrictEqual } from "node:util";

import { emitAgentEvent, hasAgentEventSink, runWithAgentEventSink } from "../rag/agent-event-stream.js";
import { runAgentRag } from "../rag/agent.js";
import {
  LANGGRAPH_CHECKPOINT_RESULT_KEY,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import {
  getActiveDatabaseTenant,
  runWithDatabaseTenant,
  toDatabaseTenant,
} from "../rag/postgres-tenant.js";
import {
  createRequestCancellation,
  getRequestDeadline,
  getRequestSignal,
  runWithRequestCancellation,
} from "../rag/request-deadline.js";
import { getActiveRunUsage } from "../rag/run-usage.js";

// What a request binds around its run must reach everything LangGraph
// schedules for it, and nothing of another request's may: the database
// tenant, the request's deadline and signal, its agent event sink and its run
// usage are all AsyncLocalStorage contexts, and the custom-Skill graph runs
// inside the outer plan graph under an empty LangChain async context
// (rag/langgraph/run-execution-graph.js). Two tenants' requests are run at
// once, held inside their first Skill call until both are there, and every
// Skill call and every run store call (the thread writes included) records
// what it sees.
//
// Until ADR 0001 phase 10 removed the v3 unified graph, this was pinned on
// that graph (test/langgraph-unified-graph.test.mjs); the executor and the
// contexts are the ones the custom-Skill graph uses.

const WORKSPACE_ID = "context-workspace";
const DOC_ID = "contract-1";
const FILE_NAME = "services-agreement.pdf";
// Selects two custom Skills (summarize the contract, then review its risks).
const QUESTION = "Review this contract for risks and key terms.";
const SUMMARY = "Contract Summary\n- Parties: Acme and Beta signed a services agreement. [Source 1]";
const RISKS = "Risk Review\n- Risk: Late notice creates renewal risk. [Source 1]";
const RISK_PROMPT = /^Perform a concise citation-backed risk review/u;

const ENV = Object.freeze({
  AGENT_PLANNER_ROLLOUT: "deterministic",
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_LONG_MEMORY_ENABLED: "false",
});

const withEnv = async (callback) => {
  const previous = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));

  Object.assign(process.env, ENV);

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

// What is bound where the probe runs. The probe event goes to whichever sink
// is bound there, so sink identity is checked by where the event lands.
let probeSequence = 0;
const observeContext = (where) => {
  probeSequence += 1;
  const probeId = `context-probe-${probeSequence}`;
  emitAgentEvent({ probeId, type: "context_probe", where });

  return {
    deadlineAt: getRequestDeadline(),
    hasSink: hasAgentEventSink(),
    probeId,
    signal: getRequestSignal(),
    tenant: getActiveDatabaseTenant(),
    usage: getActiveRunUsage(),
    where,
  };
};

// What a route binds around one request (routes/chat.js through
// runAgentRequestWithCancellation and its event sink; agent.js binds the run
// usage itself).
const createRequestStack = ({ label, scope }) => {
  const sinkEvents = [];
  const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 10 * 60 * 1000 });
  const sink = (event) => sinkEvents.push(event);
  const observations = [];

  return {
    cancellation,
    label,
    observations,
    observe: (where) => observations.push(observeContext(where)),
    run: (callback) =>
      runWithDatabaseTenant(scope, () =>
        runWithRequestCancellation(cancellation, () => runWithAgentEventSink(sink, callback))
      ),
    scope,
    sinkEvents,
  };
};

// Every call the run service makes to the store, observed where it is made
// (the saver's thread writes included), with the arguments it names.
const createObservedStore = (store, observe) => {
  const observed = {};

  for (const [name, value] of Object.entries(store)) {
    observed[name] = typeof value === "function"
      ? (...args) => {
          observe(`store:${name}`, args[0]);
          return value.apply(store, args);
        }
      : value;
  }

  return observed;
};

// Counts every way this process could reach the network; the assertion is
// that there are none. syncBuiltinESMExports carries the patched properties
// to ESM named imports of the builtins.
const withNetworkSpy = async (callback) => {
  const calls = [];
  const patches = [
    [globalThis, "fetch"],
    [http, "request"],
    [http, "get"],
    [https, "request"],
    [https, "get"],
    [net, "connect"],
    [net, "createConnection"],
    [net.Socket.prototype, "connect"],
  ];
  const originals = patches.map(([target, key]) => target[key]);

  patches.forEach(([target, key], index) => {
    const original = originals[index];
    target[key] = function spied(...args) {
      calls.push(key);
      return original.apply(this, args);
    };
  });
  syncBuiltinESMExports();

  try {
    return { calls, result: await callback() };
  } finally {
    patches.forEach(([target, key], index) => {
      target[key] = originals[index];
    });
    syncBuiltinESMExports();
  }
};

// Resolves once `count` callers arrived, so their work provably overlapped.
const createArrivalBarrier = (count) => {
  let arrived = 0;
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });

  return {
    arrive() {
      arrived += 1;
      if (arrived === count) {
        open();
      }
      return opened;
    },
    get arrived() {
      return arrived;
    },
  };
};

test("on LangGraph each request's tenant, deadline, event sink and run usage reach every custom Skill call and thread write, and two tenants' overlapping graphs never share them", async () => {
  // Not vacuous: outside a request nothing is bound.
  const outside = observeContext("outside");
  assert.deepStrictEqual(
    [outside.tenant, outside.usage, outside.signal, outside.deadlineAt, outside.hasSink],
    [null, null, null, null, false]
  );

  const store = createInMemoryAgentRunStore();
  const tenants = [
    { label: "alice", scope: { userId: "context-alice", workspaceId: WORKSPACE_ID } },
    { label: "bob", scope: { userId: "context-bob", workspaceId: WORKSPACE_ID } },
  ];
  const chatBarrier = createArrivalBarrier(tenants.length);
  // The stack of the request a store call belongs to: each call is attributed
  // by the access scope it names (the run service passes the request's scope
  // explicitly), not by the ambient tenant. The ambient context there is then
  // checked against that request's own stack, so a context swapped between
  // the two overlapping requests at a saver write fails the test instead of
  // being attributed to the other request.
  const stacksByUser = new Map();
  const unattributedStoreCalls = [];
  const storeTenantMismatches = [];
  // Every LangGraph thread record a write hands the store, by the tenant the
  // write names, copied at write time (the settling save drops the record).
  const threadRecordsByUser = new Map();
  const observeStore = (where, args) => {
    const callScope = args?.accessScope ?? null;
    const stack = stacksByUser.get(callScope?.userId);

    if (!stack) {
      // A store call that names no tenant, or an unknown one: it would be a leak.
      unattributedStoreCalls.push(where);
      return;
    }

    if (!isDeepStrictEqual(getActiveDatabaseTenant(), toDatabaseTenant(callScope))) {
      storeTenantMismatches.push({ ambient: getActiveDatabaseTenant(), named: callScope.userId, where });
    }
    stack.observe(where);

    const record = args?.patch?.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY];

    if (record !== null && record !== undefined) {
      threadRecordsByUser.get(callScope.userId).push(structuredClone(record));
    }
  };
  const agentRunStore = createObservedStore(store, observeStore);

  const contexts = tenants.map(({ label, scope }) => {
    const stack = createRequestStack({ label, scope });
    const inScope = (requested) =>
      requested?.userId === scope.userId && requested?.workspaceId === scope.workspaceId;
    let chatCalls = 0;

    stacksByUser.set(scope.userId, stack);
    threadRecordsByUser.set(scope.userId, []);

    return {
      label,
      ragService: {
        chat: async (_docIds, question) => {
          chatCalls += 1;
          const call = chatCalls;

          stack.observe(`chat:${call}`);

          if (call === 1) {
            // Both tenants' first Skill nodes are in flight at once.
            await chatBarrier.arrive();
            stack.observe("chat-after-barrier:1");
          }

          return {
            abstained: false,
            citations: [
              {
                docId: DOC_ID,
                excerpt:
                  "Acme and Beta signed a services agreement. It renews every 12 months unless either party gives 30 days notice. Late notice creates renewal risk.",
                fileName: FILE_NAME,
                pageNumber: 3,
              },
            ],
            memoryApplied: false,
            resolvedQuery: question,
            text: RISK_PROMPT.test(question) ? RISKS : SUMMARY,
          };
        },
        getDocument: (docId, requested) =>
          inScope(requested) && docId === DOC_ID ? { docId, fileName: FILE_NAME } : null,
        listDocuments: (requested) => (inScope(requested) ? [{ docId: DOC_ID, fileName: FILE_NAME }] : []),
      },
      scope,
      stack,
    };
  });

  const { calls, result: responses } = await withNetworkSpy(() =>
    withEnv(() =>
      Promise.all(
        contexts.map((context) =>
          context.stack.run(() =>
            runAgentRag({
              accessScope: context.scope,
              agentRunService: createAgentRunService({ agentRunStore }),
              docIds: [DOC_ID],
              question: QUESTION,
              ragService: context.ragService,
              sessionId: `context-session-${context.label}`,
              userId: context.scope.userId,
            })
          )
        )
      )
    )
  );

  // Not one network call: LangGraph and LangChain neither trace nor phone
  // home on their own.
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(unattributedStoreCalls, []);
  // At every store call the ambient database tenant is the tenant the call
  // names (the thread writes included).
  assert.deepStrictEqual(storeTenantMismatches, []);
  assert.equal(chatBarrier.arrived, tenants.length);

  for (const [index, context] of contexts.entries()) {
    const others = contexts.filter((_, otherIndex) => otherIndex !== index).map((other) => other.stack);
    const response = responses[index];
    const run = await store.get({ accessScope: context.scope, runId: response.body.agentRunId });
    const wheres = context.stack.observations.map((observation) => observation.where);

    // Both Skills ran as nodes of one graph on LangGraph and the run completed.
    assert.equal(response.status, 200, context.label);
    assert.equal(run.status, "completed", context.label);
    assert.deepEqual(
      run.steps.filter((step) => step.type === "custom_skill").map((step) => step.status),
      ["completed", "completed"],
      context.label
    );
    assert.deepEqual(
      wheres.filter((where) => where.startsWith("chat")),
      ["chat:1", "chat-after-barrier:1", "chat:2"],
      context.label
    );
    assert.ok(wheres.includes("store:update"), `${context.label}: the run and thread writes`);

    // One run usage per request, the same in every Skill call of it.
    const usages = new Set(
      context.stack.observations
        .filter((observation) => !observation.where.startsWith("store:"))
        .map((observation) => observation.usage)
    );
    assert.equal(usages.size, 1, context.label);
    assert.notEqual([...usages][0], null, context.label);

    for (const observation of context.stack.observations) {
      const where = `${observation.where} under ${context.label}`;

      assert.deepStrictEqual(observation.tenant, toDatabaseTenant(context.scope), `tenant at ${where}`);
      assert.equal(observation.signal, context.stack.cancellation.signal, `signal at ${where}`);
      assert.equal(
        observation.deadlineAt,
        context.stack.cancellation.store.deadlineAt,
        `deadline at ${where}`
      );
      assert.equal(observation.hasSink, true, `event sink at ${where}`);
      assert.ok(
        context.stack.sinkEvents.some((event) => event.probeId === observation.probeId),
        `the probe at ${where} reached its own sink`
      );
      for (const other of others) {
        assert.equal(
          other.sinkEvents.some((event) => event.probeId === observation.probeId),
          false,
          `the probe at ${where} leaked into ${other.label}'s sink`
        );
      }
    }
  }

  // Each tenant's thread records belong to its own run and hold nothing of
  // the other tenant's: not its user id, not its run id.
  for (const [index, context] of contexts.entries()) {
    const runId = responses[index].body.agentRunId;
    const records = threadRecordsByUser.get(context.scope.userId);
    const otherIndex = index === 0 ? 1 : 0;
    const otherTexts = [contexts[otherIndex].scope.userId, responses[otherIndex].body.agentRunId];

    assert.ok(records.length > 0, `${context.label} wrote its thread`);
    for (const record of records) {
      assert.deepStrictEqual(record.owner, {
        runId,
        userId: context.scope.userId,
        workspaceId: context.scope.workspaceId,
      });

      const serialized = JSON.stringify(record);

      for (const text of otherTexts) {
        assert.equal(serialized.includes(text), false, `${context.label}'s thread record holds ${text}`);
      }
    }
  }

  // The tenants' usages are their own.
  assert.notEqual(
    contexts[0].stack.observations.find((observation) => observation.where === "chat:1").usage,
    contexts[1].stack.observations.find((observation) => observation.where === "chat:1").usage
  );

  for (const context of contexts) {
    context.stack.cancellation.dispose();
  }
});
