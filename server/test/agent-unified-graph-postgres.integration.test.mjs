import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  UNIFIED_ACCESS_SCOPE as accessScope,
  DOCUMENT_LOOP_QUESTION,
  UNIFIED_DOC_ID,
  UNIFIED_SESSION_ID,
  WEB_QUESTION,
  checkpointHasNodeRun,
  createConditionalWebProposal,
  createCrashingRunService,
  createDocumentLoopProposal,
  createDocumentLoopRagService,
  createProposalAdapter,
  createWebChatService,
  describeAnswerState,
  scopeRecoveryToRuns,
} from "./fixtures/unified-graph-run-fixtures.mjs";

// Guarded v3 unified graph across a real process boundary, on the real
// PostgreSQL agent-run store. Each test crashes a first process at a chosen
// write (every later write of that process fails, as after an exit), then a
// separate Node process runs production startup recovery against the same
// rows. The three blocks the unfreeze requires:
//   1. document-loop gap handling and working memory survive the restart and
//      a completed follow-up is never charged or executed twice;
//   2. whole-run finalization receipts: a crash after the answer is sealed
//      completes the run with that answer, never a second one;
//   3. resume at node boundaries: completed nodes are reused only when their
//      typed-output digests reconcile; unknown in-flight document calls and
//      tampered receipts go to manual recovery.
// Approval continuation stays frozen; an approval-gated node never enters a
// guarded graph (the in-memory guarded suite covers that refusal).
// Without PGVECTOR_TEST_DATABASE_URL the suite is reported as skipped.

const databaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();
const workerMode = process.env.AGENT_UNIFIED_GRAPH_POSTGRES_WORKER ?? "";
const execFileAsync = promisify(execFile);
const RUNTIME_ENV = Object.freeze({
  AGENT_PLANNER_ROLLOUT: "deterministic",
  AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded",
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_LONG_MEMORY_ENABLED: "false",
});

const effectTable = (value) => {
  // Short enough that PostgreSQL's derived `<table>_id_seq` name stays
  // within its 63-character identifier limit.
  if (!/^ugraph_it_fx_[a-f0-9]{24}$/.test(value ?? "")) {
    throw new Error("Invalid integration effect table name.");
  }

  return value;
};

const loadModules = async () => {
  process.env.POSTGRES_DATABASE_URL = databaseUrl;
  Object.assign(process.env, RUNTIME_ENV);
  const [
    { resumeAgentExecutionGraphRun, runAgentRag },
    { createAgentRunRecoveryService },
    { createAgentRunService, createInMemoryAgentRunStore },
    { queryPostgres, resetPostgresPool },
    { createPostgresAgentRunStore },
    { createDefaultSkillRegistry, createSkillRegistry },
    { getAgentRunEventsPostgresTable, getAgentRunsPostgresTable, getPostgresTenantRole },
  ] = await Promise.all([
    import("../rag/agent.js"),
    import("../rag/agent-run-recovery.js"),
    import("../rag/agent-runs.js"),
    import("../rag/postgres.js"),
    import("../rag/postgres-agent-run-store.js"),
    import("../rag/skills/registry.js"),
    import("../rag/config.js"),
  ]);

  return {
    createAgentRunRecoveryService,
    createAgentRunService,
    createDefaultSkillRegistry,
    createInMemoryAgentRunStore,
    createSkillRegistry,
    createPostgresAgentRunStore,
    getAgentRunEventsPostgresTable,
    getAgentRunsPostgresTable,
    getPostgresTenantRole,
    queryPostgres,
    resetPostgresPool,
    resumeAgentExecutionGraphRun,
    runAgentRag,
  };
};

const newRunService = (modules) =>
  modules.createAgentRunService({ agentRunStore: modules.createPostgresAgentRunStore() });

// Startup recovery acts for each run's own tenant, so the fixture's effect
// table needs the tenant role's grants like any application table.
const createEffectTable = async (modules, table) => {
  await modules.queryPostgres(
    `CREATE TABLE ${table} (id BIGSERIAL PRIMARY KEY, label TEXT NOT NULL, phase TEXT NOT NULL, process TEXT NOT NULL)`
  );
  await modules.queryPostgres(`GRANT SELECT, INSERT ON ${table} TO ${modules.getPostgresTenantRole()}`);
  await modules.queryPostgres(
    `GRANT USAGE ON SEQUENCE ${table}_id_seq TO ${modules.getPostgresTenantRole()}`
  );
};

const effectRecorder = (modules, table, label, processName) => async ({ phase }) => {
  await modules.queryPostgres(
    `INSERT INTO ${table} (label, phase, process) VALUES ($1, $2, $3)`,
    [label, phase, processName]
  );
};

const countEffects = async (modules, table, label) => {
  const result = await modules.queryPostgres(
    `SELECT phase, process, COUNT(*)::integer AS calls FROM ${table} WHERE label = $1 GROUP BY phase, process ORDER BY phase, process`,
    [label]
  );

  return Object.fromEntries(
    result.rows.map((row) => [`${row.phase}@${row.process}`, row.calls])
  );
};

// The conditional-Web variant carries a standing Web grant, as a background
// task can; the document loop needs none.
const SCENARIOS = Object.freeze({
  conditionalWeb: {
    capabilityApprovals: { "web.search": { approved: true } },
    proposal: createConditionalWebProposal,
    question: WEB_QUESTION,
  },
  documentLoop: {
    capabilityApprovals: {},
    proposal: createDocumentLoopProposal,
    question: DOCUMENT_LOOP_QUESTION,
  },
});

const askGuarded = ({
  agentRunService,
  modules,
  ragService,
  scenario = "documentLoop",
  webChatService = createWebChatService(),
}) =>
  modules.runAgentRag({
    accessScope,
    agentRunService,
    capabilityApprovals: SCENARIOS[scenario].capabilityApprovals,
    docIds: [UNIFIED_DOC_ID],
    question: SCENARIOS[scenario].question,
    ragService,
    sessionId: UNIFIED_SESSION_ID,
    unifiedGraphPlannerAdapter: createProposalAdapter(SCENARIOS[scenario].proposal),
    userId: accessScope.userId,
    webChatService,
  });

// A Web call is an external effect too: count it in the same table.
const recordingWebChatService = (modules, table, label, processName) => {
  const web = createWebChatService();

  return async (question) => {
    await effectRecorder(modules, table, label, processName)({ phase: "web" });
    return web(question);
  };
};

// The default registry with one built-in bumped, as after a deploy.
const bumpedSkillRegistry = (modules) =>
  modules.createSkillRegistry(
    modules.createDefaultSkillRegistry().list().map((skill) =>
      skill.id === "document_rag" ? { ...skill, version: `${skill.version}-next` } : skill
    )
  );

const referenceAnswer = async (modules, followUp) =>
  describeAnswerState(
    await askGuarded({
      agentRunService: modules.createAgentRunService({
        agentRunStore: modules.createInMemoryAgentRunStore(),
      }),
      modules,
      ragService: createDocumentLoopRagService({ followUp }),
    })
  );

const crashRun = async (modules, {
  bumpSkillVersion = false,
  crashAfter,
  crashBefore,
  followUp = "resolves",
  label,
  primary = "unsupported",
  scenario = "documentLoop",
  table,
}) => {
  const { service, state } = createCrashingRunService(newRunService(modules), {
    crashAfter,
    crashBefore,
  });

  await assert.rejects(
    askGuarded({
      agentRunService: service,
      modules,
      ragService: createDocumentLoopRagService({
        followUp,
        onChat: effectRecorder(modules, table, label, "parent"),
        primary,
      }),
      scenario,
      webChatService: recordingWebChatService(modules, table, label, "parent"),
    }),
    (error) => error.code === "SIMULATED_PROCESS_EXIT"
  );
  assert.equal(state.runIds.length, 1);

  // The worker process rebuilds its providers (and registry) from this spec.
  return { bumpSkillVersion, followUp, label, primary, runId: state.runIds[0] };
};

const runRecoveryProcess = async ({ runs, table }) => {
  const child = await execFileAsync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      ...process.env,
      AGENT_UNIFIED_GRAPH_POSTGRES_EFFECT_TABLE: table,
      AGENT_UNIFIED_GRAPH_POSTGRES_RUNS: JSON.stringify(runs),
      AGENT_UNIFIED_GRAPH_POSTGRES_WORKER: "recover",
    },
    timeout: 90_000,
  });
  const line = child.stdout
    .split("\n")
    .find((entry) => entry.startsWith("UNIFIED_GRAPH_RECOVERY "));
  assert.ok(line, child.stdout);
  return JSON.parse(line.slice("UNIFIED_GRAPH_RECOVERY ".length));
};

const loadRun = async (modules, runId) => {
  const service = newRunService(modules);

  return {
    checkpoint: (await service.getExecutionGraphCheckpoint({ accessScope, runId }))
      ?.checkpoint ?? null,
    run: await service.getRun({ accessScope, runId }),
  };
};

const countEvents = (run, type) =>
  (run?.events ?? []).filter((event) => event.type === type).length;

const cleanup = async (modules, { runIds, table, tableCreated }) => {
  try {
    const runsTable = modules.getAgentRunsPostgresTable();
    const eventsTable = modules.getAgentRunEventsPostgresTable();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(runsTable) ||
        !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(eventsTable)) {
      throw new Error("Invalid configured agent-run integration table name.");
    }

    for (const runId of runIds) {
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

    if (tableCreated) {
      await modules.queryPostgres(`DROP TABLE ${table}`);
    }
  } finally {
    await modules.resetPostgresPool();
  }
};

// Runs in the separate Node process: production startup recovery, scoped to
// this suite's runs, over a fresh PostgreSQL pool and run service.
const runRecoveryWorker = async () => {
  if (!databaseUrl) {
    throw new Error("Recovery worker requires PGVECTOR_TEST_DATABASE_URL.");
  }

  const table = effectTable(process.env.AGENT_UNIFIED_GRAPH_POSTGRES_EFFECT_TABLE);
  const runs = JSON.parse(process.env.AGENT_UNIFIED_GRAPH_POSTGRES_RUNS ?? "[]");
  const modules = await loadModules();

  try {
    const service = newRunService(modules);
    const recovery = modules.createAgentRunRecoveryService({
      agentRunService: scopeRecoveryToRuns(service, runs.map((run) => run.runId)),
      recordRecoveryTrace: async () => {},
      resumeExecutionGraph: (args) => {
        const spec = runs.find((run) => run.runId === args.runId);

        return modules.resumeAgentExecutionGraphRun({
          ...args,
          agentRunService: service,
          ragService: createDocumentLoopRagService({
            followUp: spec.followUp,
            onChat: effectRecorder(modules, table, spec.label, "worker"),
            primary: spec.primary,
          }),
          skillRegistry: spec.bumpSkillVersion
            ? bumpedSkillRegistry(modules)
            : modules.createDefaultSkillRegistry(),
          webChatService: recordingWebChatService(modules, table, spec.label, "worker"),
        });
      },
    });
    const outcome = await recovery.recoverOnStartup({ mode: "auto" });

    process.stdout.write(`UNIFIED_GRAPH_RECOVERY ${JSON.stringify({
      autoRecoveredCount: outcome.autoRecoveredCount,
      failedCount: outcome.failedCount,
      manualRecoveredCount: outcome.manualRecoveredCount,
      skippedCount: outcome.skippedCount,
    })}\n`);
  } finally {
    await modules.resetPostgresPool();
  }
};

const withFixture = async (callback) => {
  const modules = await loadModules();
  const table = effectTable(`ugraph_it_fx_${randomUUID().replaceAll("-", "").slice(0, 24)}`);
  const context = { modules, runIds: [], table, tableCreated: false };

  try {
    await newRunService(modules).initialize();
    await createEffectTable(modules, table);
    context.tableCreated = true;
    await callback(context);
  } finally {
    await cleanup(modules, context);
  }
};

const track = (context, crashed) => {
  context.runIds.push(crashed.runId);
  return crashed;
};

if (workerMode === "recover") {
  await runRecoveryWorker();
} else if (!databaseUrl) {
  test("PostgreSQL guarded unified graph cross-process recovery", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; use server/scripts/run-pgvector-integration.sh",
  }, () => {});
} else {
  test("document-loop gaps and working memory survive a process restart without a second follow-up", {
    timeout: 180_000,
  }, async () => {
    await withFixture(async (context) => {
      const { modules, table } = context;
      const crashAfterFollowUp = (method, args) =>
        method === "saveExecutionGraphCheckpoint" &&
        checkpointHasNodeRun(args.checkpoint, "follow_up") &&
        !checkpointHasNodeRun(args.checkpoint, "follow_up_check");
      const runs = [
        track(context, await crashRun(modules, {
          crashAfter: crashAfterFollowUp,
          followUp: "resolves",
          label: "loop_resolves",
          table,
        })),
        track(context, await crashRun(modules, {
          crashAfter: crashAfterFollowUp,
          followUp: "unresolved",
          label: "loop_unresolved",
          table,
        })),
      ];

      for (const { label } of runs) {
        assert.deepEqual(await countEffects(modules, table, label), {
          "follow_up@parent": 1,
          "primary@parent": 1,
        });
      }

      const outcome = await runRecoveryProcess({ runs, table });
      assert.deepEqual(outcome, {
        autoRecoveredCount: 2,
        failedCount: 0,
        manualRecoveredCount: 0,
        skippedCount: 0,
      });

      for (const { followUp, label, runId } of runs) {
        const { checkpoint, run } = await loadRun(modules, runId);
        const response = checkpoint.finalization.response;

        // Nothing ran twice: both document calls happened before the exit.
        assert.deepEqual(await countEffects(modules, table, label), {
          "follow_up@parent": 1,
          "primary@parent": 1,
        }, label);
        assert.equal(response.body.agentObservability.budget.used.documentRagCalls, 2, label);
        assert.equal(response.body.agentObservability.executionLoop.followUpsRun, 1, label);
        // The gaps, claims, and loop state match an uninterrupted run.
        assert.deepEqual(
          describeAnswerState(response),
          await referenceAnswer(modules, followUp),
          label
        );
        assert.equal(
          run.status,
          followUp === "resolves" ? "completed" : "waiting_for_user",
          label
        );
        if (followUp === "unresolved") {
          assert.ok(response.body.agentWorkingMemory.unresolvedGaps.length > 0, label);
          assert.equal(
            response.body.clarification.reason,
            "document_evidence_unresolved_after_follow_up",
            label
          );
        } else {
          assert.ok(response.body.agentWorkingMemory.resolvedGaps.length > 0, label);
        }
        assert.equal(countEvents(run, "skill_graph_resume_claimed"), 1, label);
        assert.equal(countEvents(run, "auto_recovery_completed"), 1, label);
        assert.equal(countEvents(run, "manual_recovery_required"), 0, label);
        const executed = run.events.filter((event) => event.type === "unified_graph_executed");
        assert.deepEqual(
          executed.at(-1).payload.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
          [
            ["primary", "reused"],
            ["primary_check", "reused"],
            ["follow_up", "reused"],
            ["follow_up_check", "completed"],
          ],
          label
        );
      }

      // The recovered clarification is settled: the user's answer to it is a
      // new request with a new run, and the settled run is not written.
      const unresolved = runs.find((run) => run.followUp === "unresolved");
      const settledBefore = await loadRun(modules, unresolved.runId);
      const continued = await modules.runAgentRag({
        accessScope,
        agentRunId: unresolved.runId,
        agentRunService: newRunService(modules),
        docIds: [UNIFIED_DOC_ID],
        question: DOCUMENT_LOOP_QUESTION,
        ragService: createDocumentLoopRagService({
          followUp: "resolves",
          onChat: effectRecorder(modules, table, "loop_continued", "parent"),
        }),
        sessionId: UNIFIED_SESSION_ID,
        unifiedGraphPlannerAdapter: createProposalAdapter(createDocumentLoopProposal),
        userId: accessScope.userId,
        webChatService: createWebChatService(),
      });
      context.runIds.push(continued.body.agentRunId);
      const settledAfter = await loadRun(modules, unresolved.runId);
      const continuedRun = await loadRun(modules, continued.body.agentRunId);

      assert.equal(continued.status, 200);
      assert.notEqual(continued.body.agentRunId, unresolved.runId);
      assert.equal(continuedRun.run.status, "completed");
      assert.equal(
        continuedRun.run.events.find((event) => event.type === "run_continued")
          ?.payload?.previousRunId,
        unresolved.runId
      );
      assert.equal(settledAfter.run.status, "waiting_for_user");
      assert.equal(settledAfter.run.events.length, settledBefore.run.events.length);
      assert.deepEqual(settledAfter.checkpoint, settledBefore.checkpoint);
    });
  });

  test("a crash after the final answer is computed never completes the run with a second answer", {
    timeout: 180_000,
  }, async () => {
    await withFixture(async (context) => {
      const { modules, table } = context;
      const sealed = track(context, await crashRun(modules, {
        crashAfter: (method, args) =>
          method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
        label: "receipt_sealed",
        table,
      }));
      const unsealed = track(context, await crashRun(modules, {
        crashBefore: (method, args) =>
          method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
        label: "receipt_missing",
        table,
      }));
      const sealedBefore = await loadRun(modules, sealed.runId);
      const unsealedBefore = await loadRun(modules, unsealed.runId);

      assert.equal(sealedBefore.run.status, "running");
      assert.equal(sealedBefore.checkpoint.phase, "completed");
      assert.ok(sealedBefore.checkpoint.finalization);
      assert.equal(unsealedBefore.run.status, "running");
      assert.equal(unsealedBefore.checkpoint.phase, "completed");
      assert.equal(unsealedBefore.checkpoint.finalization, undefined);

      const outcome = await runRecoveryProcess({ runs: [sealed, unsealed], table });
      assert.deepEqual(outcome, {
        autoRecoveredCount: 2,
        failedCount: 0,
        manualRecoveredCount: 0,
        skippedCount: 0,
      });

      const sealedAfter = await loadRun(modules, sealed.runId);
      const unsealedAfter = await loadRun(modules, unsealed.runId);
      const expected = await referenceAnswer(modules, "resolves");

      // The sealed answer is the one the run completes with, byte for byte.
      assert.equal(sealedAfter.run.status, "completed");
      assert.deepEqual(sealedAfter.checkpoint.finalization, sealedBefore.checkpoint.finalization);
      assert.equal(
        sealedAfter.run.result.answer,
        sealedBefore.checkpoint.finalization.response.body.agentAnswer
      );
      assert.equal(countEvents(sealedAfter.run, "unified_graph_finalization_replayed"), 1);
      assert.equal(countEvents(sealedAfter.run, "unified_graph_executed"), 1);
      // Without a receipt the answer is recomputed from the same persisted
      // node outputs, with no node executed, and equals an uninterrupted run.
      assert.equal(unsealedAfter.run.status, "completed");
      assert.deepEqual(describeAnswerState(unsealedAfter.checkpoint.finalization.response), expected);
      assert.equal(
        unsealedAfter.run.events.filter((event) => event.type === "unified_graph_executed")
          .at(-1).payload.replayed,
        true
      );
      for (const label of [sealed.label, unsealed.label]) {
        assert.deepEqual(await countEffects(modules, table, label), {
          "follow_up@parent": 1,
          "primary@parent": 1,
        }, label);
      }

      // A later startup finds nothing to do: completion is terminal and the
      // claim is spent, so no second answer can be produced.
      const again = await runRecoveryProcess({ runs: [sealed, unsealed], table });
      assert.deepEqual(again, {
        autoRecoveredCount: 0,
        failedCount: 0,
        manualRecoveredCount: 0,
        skippedCount: 0,
      });
      assert.equal(
        (await loadRun(modules, sealed.runId)).run.result.answer,
        sealedAfter.run.result.answer
      );
      assert.equal(countEvents((await loadRun(modules, sealed.runId)).run, "skill_graph_resume_claimed"), 1);
    });
  });

  test("cross-process resume reuses only reconciled nodes and leaves unknown in-flight work manual", {
    timeout: 180_000,
  }, async () => {
    await withFixture(async (context) => {
      const { modules, table } = context;
      const afterPrimaryCheck = (method, args) =>
        method === "saveExecutionGraphCheckpoint" &&
        checkpointHasNodeRun(args.checkpoint, "primary_check") &&
        !checkpointHasNodeRun(args.checkpoint, "follow_up");
      const boundary = track(context, await crashRun(modules, {
        crashAfter: afterPrimaryCheck,
        label: "node_boundary",
        table,
      }));
      const tampered = track(context, await crashRun(modules, {
        crashAfter: afterPrimaryCheck,
        label: "tampered_digest",
        table,
      }));
      const inFlight = track(context, await crashRun(modules, {
        crashAfter: (method, args) =>
          method === "recordRunStep" &&
          args.status === "running" &&
          args.input?.nodeId === "follow_up",
        label: "in_flight_follow_up",
        table,
      }));

      // Rewrite one completed receipt so its typed-output digest no longer
      // matches the checkpointed output.
      const store = modules.createPostgresAgentRunStore();
      const stored = await store.get({ accessScope, runId: tampered.runId });
      await store.update({
        accessScope,
        expectedRevision: stored.revision,
        patch: {
          steps: stored.steps.map((step) =>
            step.input?.nodeId === "primary"
              ? { ...step, output: { ...step.output, typedOutputDigest: "v1:sha256:tampered" } }
              : step
          ),
        },
        runId: tampered.runId,
      });

      const outcome = await runRecoveryProcess({ runs: [boundary, tampered, inFlight], table });
      assert.deepEqual(outcome, {
        autoRecoveredCount: 1,
        failedCount: 0,
        manualRecoveredCount: 2,
        skippedCount: 0,
      });

      const resumed = await loadRun(modules, boundary.runId);
      assert.equal(resumed.run.status, "completed");
      assert.deepEqual(
        resumed.run.events.filter((event) => event.type === "unified_graph_executed")
          .at(-1).payload.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
        [
          ["primary", "reused"],
          ["primary_check", "reused"],
          ["follow_up", "completed"],
          ["follow_up_check", "completed"],
        ]
      );
      // The primary call ran once, before the exit; only the pending
      // follow-up ran in the recovering process.
      assert.deepEqual(await countEffects(modules, table, boundary.label), {
        "follow_up@worker": 1,
        "primary@parent": 1,
      });
      assert.deepEqual(
        describeAnswerState(resumed.checkpoint.finalization.response),
        await referenceAnswer(modules, "resolves")
      );

      for (const [crashed, reason] of [
        [tampered, "completed_step_without_checkpoint"],
        [inFlight, "unknown_in_flight_node"],
      ]) {
        const { checkpoint, run } = await loadRun(modules, crashed.runId);
        assert.equal(run.status, "waiting_for_user", crashed.label);
        assert.equal(run.result.recovery.mode, "manual", crashed.label);
        assert.equal(run.result.recovery.reason, reason, crashed.label);
        assert.equal(checkpoint.resumeClaim, undefined, crashed.label);
        assert.equal(countEvents(run, "skill_graph_resume_claimed"), 0, crashed.label);
        assert.equal(
          Object.keys(await countEffects(modules, table, crashed.label))
            .some((key) => key.endsWith("@worker")),
          false,
          crashed.label
        );
      }
    });
  });
  test("a skipped Web fallback resumes, and only a sealed answer survives a Skill version bump", {
    timeout: 180_000,
  }, async () => {
    await withFixture(async (context) => {
      const { modules, table } = context;
      // The primary answer is supported, so the evidence check passes and
      // the Web node (and the node after it) will be skipped; the process
      // exits right after that passing check was checkpointed.
      const webSkipped = track(context, await crashRun(modules, {
        crashAfter: (method, args) =>
          method === "saveExecutionGraphCheckpoint" &&
          checkpointHasNodeRun(args.checkpoint, "evidence_check"),
        label: "web_skipped",
        primary: "supported",
        scenario: "conditionalWeb",
        table,
      }));
      const sealedBumped = track(context, await crashRun(modules, {
        bumpSkillVersion: true,
        crashAfter: (method, args) =>
          method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
        label: "sealed_bumped",
        table,
      }));
      const unsealedBumped = track(context, await crashRun(modules, {
        bumpSkillVersion: true,
        crashBefore: (method, args) =>
          method === "saveExecutionGraphCheckpoint" && Boolean(args.checkpoint?.finalization),
        label: "unsealed_bumped",
        table,
      }));
      const sealedBefore = await loadRun(modules, sealedBumped.runId);

      const outcome = await runRecoveryProcess({
        runs: [webSkipped, sealedBumped, unsealedBumped],
        table,
      });
      assert.deepEqual(outcome, {
        autoRecoveredCount: 2,
        failedCount: 1,
        manualRecoveredCount: 1,
        skippedCount: 0,
      });

      // The recovering process has no Web grant, and needs none: the passing
      // check already decided that Web never runs.
      const resumed = await loadRun(modules, webSkipped.runId);
      assert.equal(resumed.run.status, "completed");
      assert.deepEqual(await countEffects(modules, table, webSkipped.label), {
        "primary@parent": 1,
      });
      assert.deepEqual(
        resumed.run.events.filter((event) => event.type === "unified_graph_executed")
          .at(-1).payload.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status]),
        [
          ["document", "reused"],
          ["evidence_check", "reused"],
          ["web", "skipped"],
          ["risk", "skipped"],
        ]
      );

      // A sealed receipt needs no live Skill: it completes the run as stored.
      const sealedAfter = await loadRun(modules, sealedBumped.runId);
      assert.equal(sealedAfter.run.status, "completed");
      assert.equal(
        sealedAfter.run.result.answer,
        sealedBefore.checkpoint.finalization.response.body.agentAnswer
      );

      // Recomputing needs the changed catalog: the claim holder hands the run
      // to an operator instead of leaving it running behind a spent claim.
      const manual = await loadRun(modules, unsealedBumped.runId);
      assert.equal(manual.run.status, "waiting_for_user");
      assert.equal(manual.run.result.recovery.mode, "manual");
      assert.equal(manual.run.result.recovery.reason, "graph_resume_failed");
      assert.ok(manual.checkpoint.resumeClaim?.claimId);
      assert.equal(manual.checkpoint.finalization, undefined);
      assert.equal(countEvents(manual.run, "manual_recovery_required"), 1);
      for (const crashed of [sealedBumped, unsealedBumped]) {
        assert.deepEqual(await countEffects(modules, table, crashed.label), {
          "follow_up@parent": 1,
          "primary@parent": 1,
        }, crashed.label);
      }

      // A later startup changes nothing.
      const again = await runRecoveryProcess({
        runs: [webSkipped, sealedBumped, unsealedBumped],
        table,
      });
      assert.deepEqual(again, {
        autoRecoveredCount: 0,
        failedCount: 0,
        manualRecoveredCount: 0,
        skippedCount: 1,
      });
    });
  });
}
