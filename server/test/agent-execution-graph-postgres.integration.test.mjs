import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// This suite uses the real PostgreSQL agent-run store. The first process
// checkpoints a completed write; a separate Node process runs startup
// recovery against those same rows. It skips without an explicitly selected
// integration database, never masquerading as in-memory restart coverage.
const databaseUrl = String(process.env.PGVECTOR_TEST_DATABASE_URL ?? "").trim();
const workerMode = process.env.AGENT_GRAPH_POSTGRES_RESUME_WORKER ?? "";
const execFileAsync = promisify(execFile);
const deferred = () => {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
};
const question = "Compare document A and B for risk.";
const docIds = ["doc-a", "doc-b"];
const sessionId = "graph-postgres-integration-session";
const accessScope = { userId: "graph-integration-user", workspaceId: "graph-integration-workspace" };
const requestBinding = (field) => ({ source: "request", field });
const graphNodes = [
  {
    dependsOn: [],
    failurePolicy: "continue",
    inputBindings: {
      docIds: requestBinding("docIds"),
      question: requestBinding("question"),
    },
    nodeId: "compare",
    skillId: "compare_documents",
  },
  {
    dependsOn: ["compare"],
    failurePolicy: "continue",
    inputBindings: {
      docIds: requestBinding("docIds"),
      priorFindings: { source: "node", nodeId: "compare", output: "text" },
      question: requestBinding("question"),
    },
    nodeId: "risk",
    skillId: "risk_review",
  },
];

const effectTable = (value) => {
  if (!/^agent_graph_it_effects_[a-f0-9]{32}$/.test(value ?? "")) {
    throw new Error("Invalid integration effect table name.");
  }

  return value;
};

const loadModules = async () => {
  process.env.POSTGRES_DATABASE_URL = databaseUrl;
  const [
    { createAgentBudget },
    { buildExecutionGraphCheckpointOwner, createExecutionGraphCheckpoint },
    { createExecutionGraph },
    { resumeAgentExecutionGraphRun },
    { runCustomSkillStage },
    { createAgentRunStepLifecycle },
    { createAgentRunRecoveryService },
    { createAgentRunService },
    { createAgentSkillTracker },
    { SKILL_CHAIN_MODE },
    { queryPostgres, resetPostgresPool },
    { createPostgresAgentRunStore },
    { CUSTOM_RAG_SKILL_CONTRACT },
    { createSkillRegistry },
    { SKILL_EFFECTS, SKILL_IDEMPOTENCY },
    { getAgentRunEventsPostgresTable, getAgentRunsPostgresTable, getPostgresTenantRole },
  ] = await Promise.all([
    import("../rag/agent-budget.js"),
    import("../rag/agent-execution-graph-checkpoint.js"),
    import("../rag/agent-execution-graph.js"),
    import("../rag/agent.js"),
    import("../rag/agent-custom-skill-stage.js"),
    import("../rag/agent-run-step-lifecycle.js"),
    import("../rag/agent-run-recovery.js"),
    import("../rag/agent-runs.js"),
    import("../rag/agent-skill-observability.js"),
    import("../rag/agent-planner.js"),
    import("../rag/postgres.js"),
    import("../rag/postgres-agent-run-store.js"),
    import("../rag/skills/custom/custom-skill-contract.js"),
    import("../rag/skills/registry.js"),
    import("../rag/skills/skill-contract.js"),
    import("../rag/config.js"),
  ]);

  return {
    createAgentBudget,
    buildExecutionGraphCheckpointOwner,
    createExecutionGraphCheckpoint,
    createExecutionGraph,
    resumeAgentExecutionGraphRun,
    runCustomSkillStage,
    createAgentRunStepLifecycle,
    createAgentRunRecoveryService,
    createAgentRunService,
    createAgentSkillTracker,
    SKILL_CHAIN_MODE,
    queryPostgres,
    resetPostgresPool,
    createPostgresAgentRunStore,
    CUSTOM_RAG_SKILL_CONTRACT,
    createSkillRegistry,
    SKILL_EFFECTS,
    SKILL_IDEMPOTENCY,
    getAgentRunEventsPostgresTable,
    getAgentRunsPostgresTable,
    getPostgresTenantRole,
  };
};

// Recovery replays a run acting for the run's own tenant, so a Skill's write
// lands under the row-level-security tenant role. Like any application table,
// the fixture's effect table needs a grant to that role (migration 013 grants
// the real ones).
const createEffectTable = async (modules, tableName) => {
  await modules.queryPostgres(
    `CREATE TABLE ${tableName} (id BIGSERIAL PRIMARY KEY, run_id TEXT NOT NULL, skill_id TEXT NOT NULL)`
  );
  await modules.queryPostgres(
    `GRANT SELECT, INSERT ON ${tableName} TO ${modules.getPostgresTenantRole()}`
  );
  await modules.queryPostgres(
    `GRANT USAGE ON SEQUENCE ${tableName}_id_seq TO ${modules.getPostgresTenantRole()}`
  );
};

const createSkills = (modules, tableName, runId) => {
  const createSkill = (id, effects) => ({
    ...modules.CUSTOM_RAG_SKILL_CONTRACT,
    budgetKey: "customSkillCalls",
    effects,
    execute: async ({ docIds: scopedDocIds }) => {
      await modules.queryPostgres(
        `INSERT INTO ${tableName} (run_id, skill_id) VALUES ($1, $2)`,
        [runId, id]
      );
      return {
        abstained: false,
        citations: [{ docId: scopedDocIds[0], page: 1 }],
        text: `${id} result`,
      };
    },
    id,
    idempotency: effects === modules.SKILL_EFFECTS.readOnly
      ? modules.SKILL_IDEMPOTENCY.readOnlyRag
      : modules.SKILL_IDEMPOTENCY.nondeterministic,
    kind: "custom",
    label: id,
    match: () => true,
    parallelSafe: effects === modules.SKILL_EFFECTS.readOnly,
    replaySafe: effects === modules.SKILL_EFFECTS.readOnly,
    requiresAccessScope: true,
    retryable: effects === modules.SKILL_EFFECTS.readOnly,
    version: "1.0.0",
  });

  return [
    createSkill("compare_documents", modules.SKILL_EFFECTS.workspaceWrite),
    createSkill("risk_review", modules.SKILL_EFFECTS.readOnly),
  ];
};

const newRunService = (modules) => modules.createAgentRunService({
  agentRunStore: modules.createPostgresAgentRunStore(),
});

// These wrappers only pause immediately before the real PostgreSQL CAS. Each
// contender has its own service/store instance and delegates every write to
// the production store; no fake SQL or timing-dependent sleeps are involved.
const newBarrierRunService = (modules, eventType) => {
  const store = modules.createPostgresAgentRunStore();
  const entered = deferred();
  const release = deferred();
  let paused = false;
  const service = modules.createAgentRunService({
    agentRunStore: {
      ...store,
      async updateWithEvent(args) {
        if (!paused && args.event?.type === eventType) {
          paused = true;
          entered.resolve();
          await release.promise;
        }

        return store.updateWithEvent(args);
      },
    },
  });

  return {
    entered: entered.promise,
    release: () => release.resolve(),
    service,
  };
};

const createRaceRun = async (modules, runId) => {
  const service = newRunService(modules);
  await service.initialize();
  await service.createRun({
    accessScope,
    goal: question,
    input: { docIds, sessionId, userId: accessScope.userId },
    plan: { mode: modules.SKILL_CHAIN_MODE },
    runId,
  });
  await service.appendRunEvent({
    accessScope,
    runId,
    type: "execution_planned",
    payload: { planner: { stepIds: ["custom_skills"] } },
  });
  const checkpoint = modules.createExecutionGraphCheckpoint({
    graph: modules.createExecutionGraph({ nodes: graphNodes }),
    owner: modules.buildExecutionGraphCheckpointOwner({
      accessScope,
      budgetState: modules.createAgentBudget({ maxCustomSkillCalls: 3 }),
      docIds,
      plan: { mode: modules.SKILL_CHAIN_MODE },
      question,
      selectedSkills: [
        { id: "compare_documents", version: "1.0.0" },
        { id: "risk_review", version: "1.0.0" },
      ],
      sessionId,
      userId: accessScope.userId,
    }),
  });
  await service.saveExecutionGraphCheckpoint({ accessScope, checkpoint, runId });
  return { checkpoint, service };
};

const deleteIntegrationRun = async (modules, runId) => {
  const runsTable = modules.getAgentRunsPostgresTable();
  const eventsTable = modules.getAgentRunEventsPostgresTable();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(runsTable) ||
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(eventsTable)) {
    throw new Error("Invalid configured agent-run integration table name.");
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
};

const countEffects = async (modules, tableName, runId) => {
  const result = await modules.queryPostgres(
    `SELECT skill_id, COUNT(*)::integer AS calls FROM ${tableName} WHERE run_id = $1 GROUP BY skill_id ORDER BY skill_id`,
    [runId]
  );
  return Object.fromEntries(result.rows.map((row) => [row.skill_id, row.calls]));
};

const runRecoveryWorker = async () => {
  if (!databaseUrl) {
    throw new Error("Recovery worker requires PGVECTOR_TEST_DATABASE_URL.");
  }

  const tableName = effectTable(process.env.AGENT_GRAPH_POSTGRES_EFFECT_TABLE);
  const runId = process.env.AGENT_GRAPH_POSTGRES_RUN_ID;
  if (!/^graph-postgres-it-[a-f0-9]{32}$/.test(runId ?? "")) {
    throw new Error("Invalid integration run ID.");
  }

  const modules = await loadModules();
  try {
    const service = newRunService(modules);
    const registry = modules.createSkillRegistry(createSkills(modules, tableName, runId));
    const recovery = modules.createAgentRunRecoveryService({
      agentRunService: service,
      recordRecoveryTrace: async () => {},
      resumeExecutionGraph: (args) => modules.resumeAgentExecutionGraphRun({
        ...args,
        agentRunService: service,
        ragService: {
          getDocument: (docId, scope) =>
            docIds.includes(docId) &&
            scope?.userId === accessScope.userId &&
            scope?.workspaceId === accessScope.workspaceId
              ? { docId }
              : null,
        },
        skillRegistry: registry,
      }),
    });
    const outcome = await recovery.recoverOnStartup({ mode: "auto" });
    assert.equal(outcome.autoRecoveredCount, 1);
    assert.equal(outcome.manualRecoveredCount, 0);
    assert.equal(outcome.failedCount, 0);
    process.stdout.write("GRAPH_POSTGRES_RESUME_COMPLETE\n");
  } finally {
    await modules.resetPostgresPool();
  }
};

const runClaimWorker = async () => {
  if (!databaseUrl) {
    throw new Error("Claim worker requires PGVECTOR_TEST_DATABASE_URL.");
  }

  const runId = process.env.AGENT_GRAPH_POSTGRES_RUN_ID;
  if (!/^graph-postgres-it-[a-f0-9]{32}$/.test(runId ?? "")) {
    throw new Error("Invalid integration run ID.");
  }

  const modules = await loadModules();
  try {
    const service = newRunService(modules);
    const loaded = await service.getExecutionGraphCheckpoint({ accessScope, runId });
    assert.ok(loaded?.checkpoint);
    const claim = await service.claimExecutionGraphResume({
      accessScope,
      checkpointDigest: loaded.checkpoint.digest,
      runId,
    });
    assert.equal(claim.claimed, true);
    process.stdout.write("GRAPH_POSTGRES_CLAIMED\n");
  } finally {
    await modules.resetPostgresPool();
  }
};

if (workerMode === "1") {
  await runRecoveryWorker();
} else if (workerMode === "claim") {
  await runClaimWorker();
} else if (!databaseUrl) {
  test("PostgreSQL guarded graph process-restart integration", {
    skip: "PGVECTOR_TEST_DATABASE_URL is not set; use server/scripts/run-pgvector-integration.sh",
  }, () => {});
} else {
  test("PostgreSQL guarded graph survives a separate Node process without replaying a completed write", {
    timeout: 120_000,
  }, async () => {
    const modules = await loadModules();
    const suffix = randomUUID().replaceAll("-", "");
    const tableName = effectTable(`agent_graph_it_effects_${suffix}`);
    const runId = `graph-postgres-it-${suffix}`;
    const service = newRunService(modules);
    const skills = createSkills(modules, tableName, runId);
    const registry = modules.createSkillRegistry(skills);
    const plan = { mode: modules.SKILL_CHAIN_MODE };
    let effectTableCreated = false;
    let runCreated = false;

    try {
      await service.initialize();
      await createEffectTable(modules, tableName);
      effectTableCreated = true;
      await service.createRun({
        accessScope,
        goal: question,
        input: { docIds, sessionId, userId: accessScope.userId },
        plan: {
          mode: plan.mode,
          selectedSkills: skills.map((skill) => ({
            skillId: skill.id,
            skillVersion: skill.version,
          })),
        },
        runId,
      });
      runCreated = true;
      await service.appendRunEvent({
        accessScope,
        runId,
        type: "execution_planned",
        payload: { planner: { stepIds: ["custom_skills"] } },
      });

      const budgetState = modules.createAgentBudget({ maxCustomSkillCalls: 3 });
      const tracker = modules.createAgentSkillTracker({ budgetState, selectedSkills: [] });
      let interrupted = false;
      await assert.rejects(
        modules.runCustomSkillStage({
          accessScope,
          authorizedCustomSkills: skills,
          authorizedDocIds: docIds,
          budgetState,
          buildSkillTraceDetail: tracker.buildSkillTraceDetail,
          customSkills: skills,
          docIds,
          executeObservedSkill: tracker.executeObservedSkill,
          loadExecutionGraphCheckpoint: () =>
            service.getExecutionGraphCheckpoint({ accessScope, runId }),
          mode: "guarded",
          plan,
          plannerAdapter: {
            createExecutionGraph: () => ({ nodes: graphNodes }),
            id: "postgres_graph_integration_planner",
          },
          question,
          ragService: {},
          recordSkillResult: tracker.recordSkillResult,
          recordSkippedSkill: tracker.recordSkippedSkill,
          registry,
          saveExecutionGraphCheckpoint: async (checkpoint) => {
            await service.saveExecutionGraphCheckpoint({ accessScope, checkpoint, runId });
            if (!interrupted && checkpoint.nodeRuns.length === 1) {
              interrupted = true;
              throw new Error("simulated exit after durable graph checkpoint");
            }
          },
          sessionId,
          stepLifecycle: modules.createAgentRunStepLifecycle({
            accessScope,
            agentRunService: service,
            runId,
          }),
          userId: accessScope.userId,
        }),
        /simulated exit after durable graph checkpoint/
      );

      const firstCheckpoint = await service.getExecutionGraphCheckpoint({ accessScope, runId });
      assert.deepEqual(firstCheckpoint.checkpoint.nodeRuns.map((node) => node.nodeId), ["compare"]);
      assert.deepEqual(firstCheckpoint.steps.map((step) => step.status), ["completed"]);
      assert.deepEqual(await countEffects(modules, tableName, runId), {
        compare_documents: 1,
      });

      // This is a real process boundary: the worker imports production modules
      // afresh and builds a new Postgres pool and run service from persisted rows.
      const child = await execFileAsync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: {
          ...process.env,
          AGENT_GRAPH_POSTGRES_RESUME_WORKER: "1",
          AGENT_GRAPH_POSTGRES_EFFECT_TABLE: tableName,
          AGENT_GRAPH_POSTGRES_RUN_ID: runId,
        },
        timeout: 90_000,
      });
      assert.match(child.stdout, /GRAPH_POSTGRES_RESUME_COMPLETE/);

      const restartedService = newRunService(modules);
      const completed = await restartedService.getRun({ accessScope, runId });
      const finalCheckpoint = await restartedService.getExecutionGraphCheckpoint({ accessScope, runId });
      const secondClaim = await restartedService.claimExecutionGraphResume({
        accessScope,
        checkpointDigest: finalCheckpoint.checkpoint.digest,
        runId,
      });
      assert.equal(secondClaim.claimed, false);
      assert.equal(completed.status, "completed");
      assert.equal(finalCheckpoint.checkpoint.phase, "completed");
      assert.ok(finalCheckpoint.checkpoint.resumeClaim?.claimId);
      assert.deepEqual(await countEffects(modules, tableName, runId), {
        compare_documents: 1,
        risk_review: 1,
      });
      assert.equal(completed.events.filter((event) => event.type === "skill_graph_resume_claimed").length, 1);
      assert.equal(completed.events.filter((event) => event.type === "auto_recovery_completed").length, 1);
      assert.equal(completed.events.filter((event) => event.type === "manual_recovery_required").length, 0);
      const graphEvent = completed.events.find((event) => event.type === "skill_graph_planned");
      assert.deepEqual(graphEvent?.payload?.nodeRuns.map((node) => [node.nodeId, node.status]), [
        ["compare", "reused"],
        ["risk", "completed"],
      ]);
    } finally {
      try {
        if (runCreated) {
          const runsTable = modules.getAgentRunsPostgresTable();
          const eventsTable = modules.getAgentRunEventsPostgresTable();
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(runsTable) ||
              !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(eventsTable)) {
            throw new Error("Invalid configured agent-run integration table name.");
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
        if (effectTableCreated) {
          await modules.queryPostgres(`DROP TABLE ${tableName}`);
        }
      } finally {
        await modules.resetPostgresPool();
      }
    }
  });

  test("PostgreSQL cross-process claim fences a still-live graph before its first write", {
    timeout: 120_000,
  }, async () => {
    const modules = await loadModules();
    const suffix = randomUUID().replaceAll("-", "");
    const tableName = effectTable(`agent_graph_it_effects_${suffix}`);
    const runId = `graph-postgres-it-${suffix}`;
    const service = newRunService(modules);
    const skills = createSkills(modules, tableName, runId);
    const registry = modules.createSkillRegistry(skills);
    const plan = { mode: modules.SKILL_CHAIN_MODE };
    const checkpointSaved = deferred();
    const releaseOriginal = deferred();
    let effectTableCreated = false;
    let runCreated = false;

    try {
      await service.initialize();
      await createEffectTable(modules, tableName);
      effectTableCreated = true;
      await service.createRun({
        accessScope,
        goal: question,
        input: { docIds, sessionId, userId: accessScope.userId },
        plan: {
          mode: plan.mode,
          selectedSkills: skills.map((skill) => ({
            skillId: skill.id,
            skillVersion: skill.version,
          })),
        },
        runId,
      });
      runCreated = true;
      await service.appendRunEvent({
        accessScope,
        runId,
        type: "execution_planned",
        payload: { planner: { stepIds: ["custom_skills"] } },
      });

      const budgetState = modules.createAgentBudget({ maxCustomSkillCalls: 3 });
      const tracker = modules.createAgentSkillTracker({ budgetState, selectedSkills: [] });
      const originalOutcome = modules.runCustomSkillStage({
        accessScope,
        authorizedCustomSkills: skills,
        authorizedDocIds: docIds,
        budgetState,
        buildSkillTraceDetail: tracker.buildSkillTraceDetail,
        customSkills: skills,
        docIds,
        executeObservedSkill: tracker.executeObservedSkill,
        loadExecutionGraphCheckpoint: () =>
          service.getExecutionGraphCheckpoint({ accessScope, runId }),
        mode: "guarded",
        plan,
        plannerAdapter: {
          createExecutionGraph: () => ({ nodes: graphNodes }),
          id: "postgres_graph_integration_planner",
        },
        question,
        ragService: {},
        recordSkillResult: tracker.recordSkillResult,
        recordSkippedSkill: tracker.recordSkippedSkill,
        registry,
        saveExecutionGraphCheckpoint: async (checkpoint) => {
          await service.saveExecutionGraphCheckpoint({ accessScope, checkpoint, runId });
          if (checkpoint.nodeRuns.length === 0) {
            checkpointSaved.resolve();
            await releaseOriginal.promise;
          }
        },
        sessionId,
        stepLifecycle: modules.createAgentRunStepLifecycle({
          accessScope,
          agentRunService: service,
          runId,
        }),
        userId: accessScope.userId,
      }).then(
        () => ({ error: null }),
        (error) => ({ error })
      );

      await checkpointSaved.promise;
      const child = await execFileAsync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: {
          ...process.env,
          AGENT_GRAPH_POSTGRES_RESUME_WORKER: "claim",
          AGENT_GRAPH_POSTGRES_RUN_ID: runId,
        },
        timeout: 90_000,
      });
      assert.match(child.stdout, /GRAPH_POSTGRES_CLAIMED/);

      releaseOriginal.resolve();
      const original = await originalOutcome;
      assert.equal(original.error?.code, "AGENT_GRAPH_EXECUTION_FENCED");
      assert.deepEqual(await countEffects(modules, tableName, runId), {});

      const loaded = await service.getExecutionGraphCheckpoint({ accessScope, runId });
      assert.deepEqual(loaded.steps, []);
      const resumed = await modules.resumeAgentExecutionGraphRun({
        accessScope,
        agentRunService: newRunService(modules),
        checkpoint: loaded.checkpoint,
        ragService: {
          getDocument: (docId, scope) =>
            docIds.includes(docId) &&
            scope?.userId === accessScope.userId &&
            scope?.workspaceId === accessScope.workspaceId
              ? { docId }
              : null,
        },
        run: await service.getRun({ accessScope, runId }),
        runId,
        skillRegistry: registry,
      });
      assert.equal(resumed.body?.agentRunStatus, "completed");
      assert.deepEqual(await countEffects(modules, tableName, runId), {
        compare_documents: 1,
        risk_review: 1,
      });
    } finally {
      releaseOriginal.resolve();
      try {
        if (runCreated) {
          const runsTable = modules.getAgentRunsPostgresTable();
          const eventsTable = modules.getAgentRunEventsPostgresTable();
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(runsTable) ||
              !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(eventsTable)) {
            throw new Error("Invalid configured agent-run integration table name.");
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
        if (effectTableCreated) {
          await modules.queryPostgres(`DROP TABLE ${tableName}`);
        }
      } finally {
        await modules.resetPostgresPool();
      }
    }
  });

  test("PostgreSQL manual recovery CAS wins over a concurrent graph claim and fences the old worker", {
    timeout: 120_000,
  }, async () => {
    const modules = await loadModules();
    const runId = `graph-postgres-it-${randomUUID().replaceAll("-", "")}`;
    const manual = newBarrierRunService(modules, "manual_recovery_required");
    const claimant = newBarrierRunService(modules, "skill_graph_resume_claimed");

    try {
      const { checkpoint } = await createRaceRun(modules, runId);
      const manualAttempt = manual.service.markManualRecovery({
        accessScope,
        recovery: { reason: "operator_required" },
        runId,
      });
      const claimAttempt = claimant.service.claimExecutionGraphResume({
        accessScope,
        checkpointDigest: checkpoint.digest,
        runId,
      });

      await Promise.all([manual.entered, claimant.entered]);
      manual.release();
      const manualResult = await manualAttempt;
      claimant.release();
      const claimResult = await claimAttempt;

      assert.equal(manualResult.marked, true);
      assert.equal(claimResult.claimed, false);
      const run = await claimant.service.getRun({ accessScope, runId });
      assert.equal(run.status, "waiting_for_user");
      assert.equal(run.result.recovery.mode, "manual");
      assert.equal(run.events.filter((event) => event.type === "manual_recovery_required").length, 1);
      assert.equal(run.events.filter((event) => event.type === "skill_graph_resume_claimed").length, 0);

      const oldWorker = modules.createAgentRunStepLifecycle({
        accessScope,
        agentRunService: claimant.service,
        runId,
      });
      await assert.rejects(
        oldWorker.startGraphStep({
          expectedResumeClaimId: null,
          id: "custom_skill:compare",
          input: { nodeId: "compare", skillId: "compare_documents" },
          label: "compare_documents",
          type: "custom_skill",
        }),
        (error) => error?.status === 409 && error?.code === "AGENT_GRAPH_EXECUTION_FENCED"
      );
      await assert.rejects(
        claimant.service.completeRun({ accessScope, runId }),
        (error) => error?.status === 409 && error?.code === "AGENT_GRAPH_EXECUTION_FENCED"
      );
      assert.deepEqual((await claimant.service.getRun({ accessScope, runId })).steps, []);
    } finally {
      manual.release();
      claimant.release();
      try {
        await deleteIntegrationRun(modules, runId);
      } finally {
        await modules.resetPostgresPool();
      }
    }
  });

  test("PostgreSQL graph claim CAS wins over concurrent manual recovery and permits fenced node settlement", {
    timeout: 120_000,
  }, async () => {
    const modules = await loadModules();
    const runId = `graph-postgres-it-${randomUUID().replaceAll("-", "")}`;
    const manual = newBarrierRunService(modules, "manual_recovery_required");
    const claimant = newBarrierRunService(modules, "skill_graph_resume_claimed");

    try {
      const { checkpoint } = await createRaceRun(modules, runId);
      const manualAttempt = manual.service.markManualRecovery({
        accessScope,
        recovery: { reason: "operator_required" },
        runId,
      });
      const claimAttempt = claimant.service.claimExecutionGraphResume({
        accessScope,
        checkpointDigest: checkpoint.digest,
        runId,
      });

      await Promise.all([manual.entered, claimant.entered]);
      claimant.release();
      const claimResult = await claimAttempt;
      manual.release();
      const manualResult = await manualAttempt;

      assert.equal(claimResult.claimed, true);
      assert.equal(manualResult.marked, false);
      const claimedRun = await manual.service.getRun({ accessScope, runId });
      assert.equal(claimedRun.status, "running");
      assert.equal(claimedRun.result.recovery, undefined);
      assert.equal(claimedRun.events.filter((event) => event.type === "skill_graph_resume_claimed").length, 1);
      assert.equal(claimedRun.events.filter((event) => event.type === "manual_recovery_required").length, 0);

      const worker = modules.createAgentRunStepLifecycle({
        accessScope,
        agentRunService: claimant.service,
        runId,
      });
      const id = "custom_skill:compare";
      await worker.startGraphStep({
        expectedResumeClaimId: claimResult.checkpoint.resumeClaim.claimId,
        id,
        input: { nodeId: "compare", skillId: "compare_documents" },
        label: "compare_documents",
        type: "custom_skill",
      });
      await worker.completeGraphStep({
        expectedResumeClaimId: claimResult.checkpoint.resumeClaim.claimId,
        id,
        output: { abstained: false, citations: [], text: "comparison" },
      });
      const settledRun = await manual.service.getRun({ accessScope, runId });
      assert.equal(settledRun.steps.find((step) => step.id === id)?.status, "completed");
      assert.equal(settledRun.events.filter((event) => event.type === "step_completed").length, 1);
      assert.equal(settledRun.events.filter((event) => event.type === "manual_recovery_required").length, 0);
    } finally {
      manual.release();
      claimant.release();
      try {
        await deleteIntegrationRun(modules, runId);
      } finally {
        await modules.resetPostgresPool();
      }
    }
  });

  test("PostgreSQL manual recovery CAS fences a concurrent in-flight graph node settlement", {
    timeout: 120_000,
  }, async () => {
    const modules = await loadModules();
    const runId = `graph-postgres-it-${randomUUID().replaceAll("-", "")}`;
    const manual = newBarrierRunService(modules, "manual_recovery_required");
    const worker = newBarrierRunService(modules, "step_completed");

    try {
      await createRaceRun(modules, runId);
      const lifecycle = modules.createAgentRunStepLifecycle({
        accessScope,
        agentRunService: worker.service,
        runId,
      });
      const id = "custom_skill:compare";
      await lifecycle.startGraphStep({
        expectedResumeClaimId: null,
        id,
        input: { nodeId: "compare", skillId: "compare_documents" },
        label: "compare_documents",
        type: "custom_skill",
      });

      const manualAttempt = manual.service.markManualRecovery({
        accessScope,
        recovery: { reason: "operator_required" },
        runId,
      });
      const settlementAttempt = lifecycle.completeGraphStep({
        expectedResumeClaimId: null,
        id,
        output: { abstained: false, citations: [], text: "comparison" },
      });
      await Promise.all([manual.entered, worker.entered]);
      manual.release();
      assert.equal((await manualAttempt).marked, true);
      worker.release();
      await assert.rejects(
        settlementAttempt,
        (error) => error?.status === 409 && error?.code === "AGENT_GRAPH_EXECUTION_FENCED"
      );

      const run = await manual.service.getRun({ accessScope, runId });
      assert.equal(run.status, "waiting_for_user");
      assert.equal(run.steps.find((step) => step.id === id)?.status, "running");
      assert.equal(run.events.filter((event) => event.type === "manual_recovery_required").length, 1);
      assert.equal(run.events.filter((event) => event.type === "step_completed").length, 0);
    } finally {
      manual.release();
      worker.release();
      try {
        await deleteIntegrationRun(modules, runId);
      } finally {
        await modules.resetPostgresPool();
      }
    }
  });
}
