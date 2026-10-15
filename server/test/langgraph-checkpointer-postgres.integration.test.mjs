// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-spike/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// The production LangGraph checkpointer (rag/langgraph/checkpointer.js) on the
// real PostgreSQL agent-run store: its record round-trips the runs row's JSONB
// result column, its writes are the store's revision CAS under row-level
// security, and the graph checkpoint's claim fences it. Every statement runs
// as the run's own tenant (runWithDatabaseTenant), the request path; the
// rows are created and deleted by this suite only. It skips without an
// explicitly selected integration database, never masquerading as in-memory
// coverage (that is test/langgraph-checkpointer.test.mjs).
const databaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();

// Ids no other integration suite uses: other suites share this disposable
// database and may run concurrently.
const accessScope = Object.freeze({
  userId: "langgraph-saver-it-user",
  workspaceId: "langgraph-saver-it-workspace",
});
const otherScope = Object.freeze({
  userId: "langgraph-saver-it-other",
  workspaceId: "langgraph-saver-it-workspace",
});
const question = "What is the notice period?";
const docIds = ["doc-1"];
const sessionId = "langgraph-saver-it-session";
const newRunId = () => `langgraph-saver-it-${randomUUID().replaceAll("-", "")}`;

const loadModules = async () => {
  process.env.POSTGRES_DATABASE_URL = databaseUrl;
  const [
    { MemorySaver, Command },
    contract,
    { buildExecutionGraphCheckpointOwner, createExecutionGraphCheckpoint },
    { createExecutionGraph },
    { isAgentRunRevisionConflictError },
    {
      LANGGRAPH_CHECKPOINT_RESULT_KEY,
      createAgentRunCursor,
      createAgentRunService,
    },
    { LANGGRAPH_CHECKPOINT_FORMAT, RunStoreCheckpointSaver },
    { queryPostgres, resetPostgresPool },
    { createPostgresAgentRunStore },
    { runWithDatabaseTenant, toDatabaseTenant },
    { getAgentRunEventsPostgresTable, getAgentRunsPostgresTable },
  ] = await Promise.all([
    import("@langchain/langgraph"),
    import("./langgraph-checkpointer-contract.mjs"),
    import("../rag/agent-execution-graph-checkpoint.js"),
    import("../rag/agent-execution-graph.js"),
    import("../rag/agent-run-revision.js"),
    import("../rag/agent-runs.js"),
    import("../rag/langgraph/checkpointer.js"),
    import("../rag/postgres.js"),
    import("../rag/postgres-agent-run-store.js"),
    import("../rag/postgres-tenant.js"),
    import("../rag/config.js"),
  ]);

  return {
    Command,
    MemorySaver,
    contract,
    buildExecutionGraphCheckpointOwner,
    createExecutionGraphCheckpoint,
    createExecutionGraph,
    isAgentRunRevisionConflictError,
    LANGGRAPH_CHECKPOINT_RESULT_KEY,
    createAgentRunCursor,
    createAgentRunService,
    LANGGRAPH_CHECKPOINT_FORMAT,
    RunStoreCheckpointSaver,
    queryPostgres,
    resetPostgresPool,
    createPostgresAgentRunStore,
    runWithDatabaseTenant,
    toDatabaseTenant,
    getAgentRunEventsPostgresTable,
    getAgentRunsPostgresTable,
  };
};

// A new store instance per "process": nothing in memory is shared between
// two of them, only the database rows.
const newRunService = (modules, wrapStore = (store) => store) =>
  modules.createAgentRunService({
    agentRunStore: wrapStore(modules.createPostgresAgentRunStore()),
  });

const createSaver = (modules, { agentRunService, runId, scope = accessScope, ...options }) =>
  new modules.RunStoreCheckpointSaver({ agentRunService, accessScope: scope, runId, ...options });

const asTenant = (modules, callback, scope = accessScope) =>
  modules.runWithDatabaseTenant(scope, callback);

const createRun = (modules, service, runId, { plan = { mode: "document_qa" } } = {}) =>
  asTenant(modules, () =>
    service.createRun({
      accessScope,
      goal: question,
      input: { docIds, sessionId, userId: accessScope.userId },
      plan,
      runId,
    })
  );

// The raw row as the store returns it, private keys included.
const readRawRun = (modules, runId) =>
  asTenant(modules, () => modules.createPostgresAgentRunStore().get({ accessScope, runId }));

const deleteIntegrationRuns = async (modules, runIds) => {
  const runsTable = modules.getAgentRunsPostgresTable();
  const eventsTable = modules.getAgentRunEventsPostgresTable();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(runsTable) ||
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(eventsTable)) {
    throw new Error("Invalid configured agent-run integration table name.");
  }
  for (const runId of runIds) {
    if (!/^langgraph-saver-it-[a-f0-9]{32}$/.test(runId)) {
      throw new Error("Invalid integration run ID.");
    }
    const values = [accessScope.userId, accessScope.workspaceId, runId];
    await modules.queryPostgres(
      `DELETE FROM ${eventsTable} WHERE user_id = $1 AND workspace_id = $2 AND run_id = $3`,
      values
    );
    await modules.queryPostgres(
      `DELETE FROM ${runsTable} WHERE user_id = $1 AND workspace_id = $2 AND run_id = $3`,
      values
    );
  }
};

const rejectsWithCode = (promise, code, status) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (status !== undefined) {
      assert.equal(error.status, status);
    }
    return true;
  });

const threadConfig = (saver, configurable = {}) => ({
  configurable: { thread_id: saver.threadId, checkpoint_ns: "", ...configurable },
});

// Runs `body` with the modules loaded and the migrations applied, then
// removes the suite's rows and closes the pool, whatever happened.
const withIntegration = async (body) => {
  const modules = await loadModules();
  const runIds = [];

  try {
    // Migrations run as the owner, outside any tenant.
    await newRunService(modules).initialize();
    await body({ modules, track: (runId) => (runIds.push(runId), runId) });
  } finally {
    try {
      await deleteIntegrationRuns(modules, runIds);
    } finally {
      await modules.resetPostgresPool();
    }
  }
};

if (!databaseUrl) {
  test("PostgreSQL LangGraph checkpointer integration", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; run `bash scripts/run-pgvector-integration.sh` (test:pgvector) or set it",
  }, () => {});
} else {
  test("on PostgreSQL the record matches MemorySaver, survives a new store instance, writes no event and stays private", {
    timeout: 120_000,
  }, () => withIntegration(async ({ modules, track }) => {
    const { contract } = modules;
    const runId = track(newRunId());
    const service = newRunService(modules);
    await createRun(modules, service, runId);
    const saver = createSaver(modules, { agentRunService: service, runId });
    const reference = new modules.MemorySaver();

    const ours = await asTenant(modules, () => contract.applyContractScript(saver, saver.threadId));
    const theirs = await contract.applyContractScript(reference, saver.threadId);

    // Read back through another store instance: only the JSONB row carries
    // the record across.
    const restarted = createSaver(modules, { agentRunService: newRunService(modules), runId });
    const actual = await asTenant(modules, () => contract.readContract(restarted, restarted.threadId, ours));
    const expected = await contract.readContract(reference, saver.threadId, theirs);

    assert.deepStrictEqual(actual, expected);
    assert.deepStrictEqual(actual.addressed.pendingWrites, contract.EXPECTED_CONTRACT_PENDING_WRITES);
    assert.ok(actual.listRoot.at(-1).checkpoint.channel_values.lookup instanceof Map);
    assert.ok(Object.hasOwn(actual.listRoot.at(-1).checkpoint.channel_values, "missing"));

    const raw = await readRawRun(modules, runId);
    const record = raw.result[modules.LANGGRAPH_CHECKPOINT_RESULT_KEY];
    assert.equal(record.format, modules.LANGGRAPH_CHECKPOINT_FORMAT);
    assert.equal(record.threadId, saver.threadId);
    assert.deepStrictEqual(record.owner, { ...accessScope, runId });
    // 4 puts and 6 changed putWrites (the late regular write was a no-op).
    assert.equal(record.sequence, 10);
    assert.equal(raw.revision, 10);
    assert.deepStrictEqual(raw.events.map((event) => event.type), ["run_created"]);

    const publicRun = await asTenant(modules, () => service.getRun({ accessScope, runId }));
    const listed = await asTenant(modules, () => service.listRuns({ accessScope }));
    assert.equal(Object.hasOwn(publicRun.result, modules.LANGGRAPH_CHECKPOINT_RESULT_KEY), false);
    for (const run of listed.runs) {
      assert.equal(Object.hasOwn(run.result, modules.LANGGRAPH_CHECKPOINT_RESULT_KEY), false);
    }
    await rejectsWithCode(
      asTenant(modules, () =>
        service.updateRun({
          accessScope,
          patch: { result: { [modules.LANGGRAPH_CHECKPOINT_RESULT_KEY]: null } },
          runId,
        })
      ),
      "AGENT_GRAPH_CHECKPOINT_PRIVATE_FIELD",
      409
    );
  }));

  test("on PostgreSQL a StateGraph interrupted on one store instance resumes on another, and concurrent Send writes all commit", {
    timeout: 120_000,
  }, () => withIntegration(async ({ modules, track }) => {
    const { contract } = modules;
    const runId = track(newRunId());
    const firstService = newRunService(modules);
    await createRun(modules, firstService, runId);
    const effects = contract.createEffects();
    const tenantsSeen = [];
    const runCursor = modules.createAgentRunCursor();
    const firstSaver = createSaver(modules, { agentRunService: firstService, runCursor, runId });
    const config = { configurable: { thread_id: firstSaver.threadId }, durability: "sync" };

    const interrupted = await asTenant(modules, () =>
      contract.buildApprovalGraph({ checkpointer: firstSaver, effects, tenantsSeen }).invoke({ trail: [] }, config)
    );
    assert.deepStrictEqual(interrupted.trail, ["plan"]);
    assert.deepStrictEqual(interrupted.__interrupt__.map((entry) => entry.value), [{ gateId: "gate-1" }]);
    // The cursor holds the row the last saver write committed.
    assert.equal(
      runCursor.read({ accessScope, runId }).revision,
      (await readRawRun(modules, runId)).revision
    );

    const secondSaver = createSaver(modules, { agentRunService: newRunService(modules), runId });
    const secondGraph = contract.buildApprovalGraph({ checkpointer: secondSaver, effects, tenantsSeen });
    const pending = await asTenant(modules, () => secondGraph.getState({ configurable: { thread_id: secondSaver.threadId } }));
    assert.deepStrictEqual(pending.next, ["gate"]);

    const completed = await asTenant(modules, () =>
      secondGraph.invoke(new modules.Command({ resume: { approved: true } }), config)
    );
    assert.deepStrictEqual(completed, { approval: "approved", trail: ["plan", "gate", "finish"] });
    assert.deepStrictEqual(effects, { afterInterrupt: 1, beforeInterrupt: 2, finish: 1, plan: 1 });
    for (const tenant of tenantsSeen) {
      assert.deepStrictEqual(tenant, modules.toDatabaseTenant(accessScope));
    }
    const finished = await readRawRun(modules, runId);
    assert.deepStrictEqual(finished.events.map((event) => event.type), ["run_created"]);
    assert.equal(finished.status, "running");

    // Four Send branches finish together and hand the saver overlapping
    // putWrites; every one commits through the CAS.
    const fanOutRunId = track(newRunId());
    const fanOutService = newRunService(modules);
    await createRun(modules, fanOutService, fanOutRunId);
    const fanOutSaver = createSaver(modules, { agentRunService: fanOutService, runId: fanOutRunId });
    const observed = { branchTenants: [], joined: null };
    await asTenant(modules, () =>
      contract
        .buildFanOutGraph({ branchCount: 4, checkpointer: fanOutSaver, observed })
        .invoke({}, { configurable: { thread_id: fanOutSaver.threadId }, durability: "sync" })
    );
    assert.deepStrictEqual(observed.joined, ["branch-0", "branch-1", "branch-2", "branch-3"]);
    const fanOutRecord = (await readRawRun(modules, fanOutRunId))
      .result[modules.LANGGRAPH_CHECKPOINT_RESULT_KEY];
    const branchWrites = fanOutRecord.namespaces[0].writes.filter((write) => write.channel === "done");
    assert.equal(new Set(branchWrites.map((write) => write.taskId)).size, 4);
  }));

  test("on PostgreSQL a v1 custom-Skill graph claim fences the saver, manual recovery fences the claimant, and another tenant reads nothing", {
    timeout: 120_000,
  }, () => withIntegration(async ({ modules, track }) => {
    const { checkpointId, makeCheckpoint, INPUT_METADATA, loopMetadata } = modules.contract;
    const runId = track(newRunId());
    const plan = { mode: "skill_chain" };
    const service = newRunService(modules);
    await createRun(modules, service, runId, { plan });
    const graph = modules.createExecutionGraph({
      nodes: [{
        dependsOn: [],
        failurePolicy: "continue",
        inputBindings: {
          docIds: { source: "request", field: "docIds" },
          question: { source: "request", field: "question" },
        },
        nodeId: "compare",
        skillId: "compare_documents",
      }],
    });
    const graphCheckpoint = modules.createExecutionGraphCheckpoint({
      graph,
      owner: modules.buildExecutionGraphCheckpointOwner({
        accessScope,
        budgetState: { limits: {}, used: {} },
        docIds,
        plan,
        question,
        selectedSkills: [],
        sessionId,
        userId: accessScope.userId,
      }),
      version: "v1",
    });
    await asTenant(modules, () =>
      service.saveExecutionGraphCheckpoint({ accessScope, checkpoint: graphCheckpoint, runId })
    );

    const original = createSaver(modules, { agentRunService: service, runId });
    const first = await asTenant(modules, () =>
      original.put(threadConfig(original), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {})
    );

    // A recovery worker in another "process" claims the graph.
    const claim = await asTenant(modules, () =>
      newRunService(modules).claimExecutionGraphResume({
        accessScope,
        checkpointDigest: graphCheckpoint.digest,
        runId,
      })
    );
    assert.equal(claim.claimed, true);
    const claimId = claim.checkpoint.resumeClaim.claimId;

    const beforeFence = await readRawRun(modules, runId);
    await rejectsWithCode(
      asTenant(modules, () => original.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {})),
      "AGENT_GRAPH_EXECUTION_FENCED",
      409
    );
    await rejectsWithCode(
      asTenant(modules, () => original.putWrites(first, [["trail", "x"]], "task-1")),
      "AGENT_GRAPH_EXECUTION_FENCED",
      409
    );
    assert.equal((await readRawRun(modules, runId)).revision, beforeFence.revision);

    const recovery = createSaver(modules, {
      agentRunService: newRunService(modules),
      graphResumeClaimId: claimId,
      runId,
    });
    await asTenant(modules, () => recovery.put(first, makeCheckpoint(checkpointId(2)), loopMetadata(0), {}));
    assert.equal(
      (await asTenant(modules, () => recovery.getTuple(threadConfig(recovery)))).checkpoint.id,
      checkpointId(2)
    );
    // The saver never touched the graph checkpoint.
    assert.deepStrictEqual(
      (await readRawRun(modules, runId)).result.__skillGraphCheckpoint,
      claim.checkpoint
    );

    // Another tenant: the policy hides the row, so the run does not exist.
    const outsider = createSaver(modules, {
      agentRunService: newRunService(modules),
      runId,
      scope: otherScope,
    });
    await rejectsWithCode(
      asTenant(modules, () => outsider.getTuple(threadConfig(outsider)), otherScope),
      "LANGGRAPH_RUN_NOT_FOUND",
      404
    );
    await rejectsWithCode(
      asTenant(modules, () => outsider.put(threadConfig(outsider), makeCheckpoint(checkpointId(9)), INPUT_METADATA, {}), otherScope),
      "LANGGRAPH_RUN_NOT_FOUND",
      404
    );
    // The right saver in the wrong tenant's request never reaches the store.
    await rejectsWithCode(
      asTenant(modules, () => recovery.getTuple(threadConfig(recovery)), otherScope),
      "LANGGRAPH_TENANT_MISMATCH",
      409
    );

    // The claimant hands the run to an operator: its next write is fenced.
    const marked = await asTenant(modules, () =>
      service.markManualRecovery({
        accessScope,
        expectedGraphResumeClaimId: claimId,
        recovery: { reason: "checkpointer_integration" },
        runId,
      })
    );
    assert.equal(marked.marked, true);
    await rejectsWithCode(
      asTenant(modules, () => recovery.put(threadConfig(recovery, { checkpoint_id: checkpointId(2) }), makeCheckpoint(checkpointId(3)), loopMetadata(1), {})),
      "AGENT_GRAPH_EXECUTION_FENCED",
      409
    );
    const final = await readRawRun(modules, runId);
    assert.deepStrictEqual(
      final.events.map((event) => event.type),
      ["run_created", "skill_graph_checkpointed", "skill_graph_resume_claimed", "manual_recovery_required"]
    );
  }));

  test("on PostgreSQL a commit between the saver's read and its CAS forces the service's retry, and both writes survive", {
    timeout: 120_000,
  }, () => withIntegration(async ({ modules, track }) => {
    const { checkpointId, deferred, makeCheckpoint, INPUT_METADATA } = modules.contract;
    const runId = track(newRunId());
    const reached = deferred();
    const release = deferred();
    const stats = { conflicts: 0 };
    let armed = false;
    const service = newRunService(modules, (store) => ({
      ...store,
      async get(args) {
        const run = await store.get(args);
        if (armed) {
          armed = false;
          reached.resolve();
          await release.promise;
        }
        return run;
      },
      async update(args) {
        try {
          return await store.update(args);
        } catch (error) {
          if (modules.isAgentRunRevisionConflictError(error)) {
            stats.conflicts += 1;
          }
          throw error;
        }
      },
    }));
    await createRun(modules, service, runId);
    const saver = createSaver(modules, { agentRunService: service, runId });

    armed = true;
    const pendingPut = asTenant(modules, () =>
      saver.put(threadConfig(saver), makeCheckpoint(checkpointId(1)), INPUT_METADATA, {})
    );
    await reached.promise;
    await asTenant(modules, () =>
      newRunService(modules).updateRun({
        accessScope,
        patch: { result: { foreignReceipt: { id: "receipt-1" } } },
        runId,
      })
    );
    release.resolve();
    await pendingPut;

    assert.equal(stats.conflicts, 1);
    const raw = await readRawRun(modules, runId);
    assert.deepStrictEqual(raw.result.foreignReceipt, { id: "receipt-1" });
    assert.equal(raw.result[modules.LANGGRAPH_CHECKPOINT_RESULT_KEY].namespaces[0].checkpoints[0].id, checkpointId(1));
    assert.equal(raw.revision, 2);
  }));
}
