import test from "node:test";
import assert from "node:assert/strict";

import { runAgentRag } from "../rag/agent.js";
import {
  AGENT_TASK_ACTIONS,
  createAgentTaskRunner,
} from "../rag/agent-tasks.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { hasUnifiedGuardedGraphPath } from "../rag/agent-unified-graph-run.js";
import {
  DOCUMENT_LOOP_QUESTION,
  UNIFIED_ACCESS_SCOPE as accessScope,
  UNIFIED_DOC_ID,
  UNIFIED_SESSION_ID,
  WEB_QUESTION,
  createConditionalWebProposal,
  createDocumentLoopProposal,
  createDocumentLoopRagService,
  createProposalAdapter,
  createWebChatService,
  createWebHandOffProposal,
  nodeBinding,
  requestBinding,
} from "./fixtures/unified-graph-run-fixtures.mjs";

// What an admitted guarded graph may do with data, compared with V1 on the
// same request: which text reaches the external Web provider, whether the
// selected documents stay first, whether Web text can enter a Skill prompt,
// and whether a no-op Skill node can change the finalizer's evidence policy.
// Also: a stage refusal after `selected` still hands the request to V1, and a
// settled graph-owned run is continued as a new run.

const withEnv = async (overrides, callback) => {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const ENV = Object.freeze({
  AGENT_PLANNER_ROLLOUT: "deterministic",
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_LONG_MEMORY_ENABLED: "false",
});
const STANDING_WEB_GRANT = Object.freeze({ "web.search": Object.freeze({ approved: true }) });

const newService = () => createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });

const ask = async ({
  agentRunId,
  agentRunService = newService(),
  capabilityApprovals = STANDING_WEB_GRANT,
  mode,
  proposal,
  question,
  ragService,
  taskMemory,
  webCalls = [],
}) => {
  const response = await withEnv({ ...ENV, AGENT_UNIFIED_GRAPH_ROLLOUT: mode }, () =>
    runAgentRag({
      accessScope,
      ...(agentRunId ? { agentRunId } : {}),
      agentRunService,
      capabilityApprovals,
      docIds: [UNIFIED_DOC_ID],
      question,
      ragService,
      sessionId: UNIFIED_SESSION_ID,
      ...(taskMemory ? { taskMemory } : {}),
      ...(proposal ? { unifiedGraphPlannerAdapter: createProposalAdapter(proposal) } : {}),
      userId: accessScope.userId,
      webChatService: createWebChatService({ calls: webCalls }),
    })
  );
  const run = await agentRunService.getRun({ accessScope, runId: response.body.agentRunId });
  const checkpoint = (await agentRunService.getExecutionGraphCheckpoint({
    accessScope,
    runId: response.body.agentRunId,
  }))?.checkpoint ?? null;

  return { checkpoint, response, run };
};

const plannedEvents = (run) =>
  (run?.events ?? [])
    .filter((event) => event.type === "unified_graph_planned")
    .map((event) => ({
      errorCodes: event.payload.errorCodes,
      status: event.payload.status,
      supersedes: event.payload.supersedes ?? null,
    }));

const describeAnswer = ({ response }) => ({
  agentAnswer: response.body.agentAnswer,
  agentMode: response.body.agentMode,
  sources: (response.body.ragSources ?? []).map((source) => source.url ?? source.docId),
  status: response.status,
});

const threeNodeConditionalWeb = () => ({
  nodes: createConditionalWebProposal().nodes.filter((node) => node.nodeId !== "risk"),
});

test("a Web node never sends upstream document text to the external provider", async () => {
  const webCalls = [];
  const ragService = createDocumentLoopRagService();
  const { checkpoint, response, run } = await ask({
    mode: "guarded",
    proposal: () => ({
      nodes: threeNodeConditionalWeb().nodes.map((node) =>
        node.nodeId === "web"
          ? {
              ...node,
              dependsOn: ["document", "evidence_check"],
              inputBindings: { question: nodeBinding("document", "text") },
            }
          : node
      ),
    }),
    question: WEB_QUESTION,
    ragService,
    webCalls,
  });

  assert.deepEqual(plannedEvents(run), [
    { errorCodes: ["external_input_not_request_question"], status: "rejected", supersedes: null },
  ]);
  assert.equal(checkpoint, null);
  // V1 answered; its Web call (the intent asked for Web) carried only the
  // user's own question, never the document answer.
  assert.equal(response.status, 200);
  assert.deepEqual(webCalls, [WEB_QUESTION]);
  assert.equal(webCalls.some((query) => /60 days/.test(query)), false);
});

test("a document-scoped request is never answered from the Web alone", async () => {
  const v1 = await ask({
    mode: "off",
    question: DOCUMENT_LOOP_QUESTION,
    ragService: createDocumentLoopRagService({ primary: "supported" }),
  });
  const webOnly = () => ({
    nodes: [{
      dependsOn: [],
      failurePolicy: "fail_fast",
      inputBindings: { question: requestBinding("question") },
      nodeId: "web",
      skillId: "web_search",
    }],
  });
  const ungated = () => ({
    nodes: [
      threeNodeConditionalWeb().nodes[0],
      {
        dependsOn: ["document"],
        failurePolicy: "fail_fast",
        inputBindings: { question: requestBinding("question") },
        nodeId: "web",
        skillId: "web_search",
      },
    ],
  });

  for (const [proposal, expectedCodes] of [
    [webOnly, ["document_request_without_document_node", "web_not_gated_on_document_evidence"]],
    [ungated, ["web_not_gated_on_document_evidence"]],
  ]) {
    const webCalls = [];
    const ragService = createDocumentLoopRagService({ primary: "supported" });
    const guarded = await ask({
      mode: "guarded",
      proposal,
      question: DOCUMENT_LOOP_QUESTION,
      ragService,
      webCalls,
    });

    assert.deepEqual(plannedEvents(guarded.run), [
      { errorCodes: expectedCodes, status: "rejected", supersedes: null },
    ]);
    assert.equal(webCalls.length, 0);
    assert.deepEqual(describeAnswer(guarded), describeAnswer(v1));
    assert.deepEqual(describeAnswer(guarded).sources, [UNIFIED_DOC_ID]);
  }

  // Under a Web-wanting intent a Web node may run unconditionally, but the
  // primary document answer still must: one behind a condition could be
  // skipped and leave a Web-only answer labelled document_web.
  const skippablePrimary = await ask({
    mode: "guarded",
    proposal: () => ({
      nodes: [
        {
          dependsOn: [],
          failurePolicy: "fail_fast",
          inputBindings: { docIds: requestBinding("docIds"), question: requestBinding("question") },
          nodeId: "risk",
          skillId: "risk_review",
        },
        {
          ...threeNodeConditionalWeb().nodes[0],
          dependsOn: ["risk"],
          when: { equals: true, nodeId: "risk", output: "abstained" },
        },
        {
          dependsOn: [],
          failurePolicy: "fail_fast",
          inputBindings: { question: requestBinding("question") },
          nodeId: "web",
          skillId: "web_search",
        },
      ],
    }),
    question: WEB_QUESTION,
    ragService: createDocumentLoopRagService({ primary: "supported" }),
  });
  assert.deepEqual(plannedEvents(skippablePrimary.run), [
    { errorCodes: ["document_request_without_document_node"], status: "rejected", supersedes: null },
  ]);

  // Gated on the primary answer's own evidence check, the same Web node is
  // admitted, and with supported evidence it never runs.
  const webCalls = [];
  const gated = await ask({
    mode: "guarded",
    proposal: threeNodeConditionalWeb,
    question: DOCUMENT_LOOP_QUESTION,
    ragService: createDocumentLoopRagService({ primary: "supported" }),
    webCalls,
  });
  assert.deepEqual(plannedEvents(gated.run), [
    { errorCodes: [], status: "selected", supersedes: null },
  ]);
  assert.equal(webCalls.length, 0);
  assert.deepEqual(describeAnswer(gated), describeAnswer(v1));
});

test("Web output is never handed to a Skill prompt", async () => {
  const ragService = createDocumentLoopRagService({ primary: "abstain" });
  const { checkpoint, run } = await ask({
    mode: "guarded",
    proposal: createWebHandOffProposal,
    question: WEB_QUESTION,
    ragService,
  });

  assert.deepEqual(plannedEvents(run), [
    { errorCodes: ["external_output_hand_off"], status: "rejected", supersedes: null },
  ]);
  assert.equal(checkpoint, null);
  assert.equal(
    ragService.calls.some((call) => /Upstream findings from an earlier step/.test(call.question)),
    false
  );
  assert.equal(ragService.calls.some((call) => /45 days/.test(call.question)), false);
});

test("an abstaining Skill node does not change which evidence verifies the answer", async () => {
  const withNoOpSkill = () => ({
    nodes: [
      ...threeNodeConditionalWeb().nodes,
      {
        dependsOn: ["document"],
        failurePolicy: "fail_fast",
        inputBindings: { docIds: requestBinding("docIds"), question: requestBinding("question") },
        nodeId: "no_op_risk",
        skillId: "risk_review",
      },
    ],
  });
  const variants = {
    graph: await ask({
      mode: "guarded",
      proposal: threeNodeConditionalWeb,
      question: WEB_QUESTION,
      ragService: createDocumentLoopRagService({ primary: "abstain" }),
    }),
    graphWithNoOpSkill: await ask({
      mode: "guarded",
      proposal: withNoOpSkill,
      question: WEB_QUESTION,
      ragService: createDocumentLoopRagService({ primary: "abstain" }),
    }),
    v1: await ask({
      mode: "off",
      question: WEB_QUESTION,
      ragService: createDocumentLoopRagService({ primary: "abstain" }),
    }),
  };

  assert.equal(
    variants.graphWithNoOpSkill.run.steps.filter(
      (step) => step.type === "graph_node" && step.input?.nodeId === "no_op_risk"
    ).length,
    1
  );
  // The document answer abstained and Web context alone never verifies a
  // document-mode claim: all three abstain, none cites the Web page.
  for (const [label, variant] of Object.entries(variants)) {
    assert.deepEqual(describeAnswer(variant), describeAnswer(variants.v1), label);
    assert.equal(/45 days/.test(variant.response.body.agentAnswer), false, label);
  }
});

test("a stage refusal after selection hands the untouched request to V1", async () => {
  // A selected document disappears between planning and the stage (another
  // instance deleted it). The planner and admission saw it; the stage's live
  // catalog does not, so it refuses before its first checkpoint write.
  const base = createDocumentLoopRagService({ primary: "supported" });
  let deleted = false;
  const ragService = {
    ...base,
    getDocument: (docId, scope) => (deleted ? null : base.getDocument(docId, scope)),
  };
  const agentRunService = newService();
  const response = await withEnv({ ...ENV, AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded" }, () =>
    runAgentRag({
      accessScope,
      agentRunService,
      docIds: [UNIFIED_DOC_ID],
      question: DOCUMENT_LOOP_QUESTION,
      ragService,
      sessionId: UNIFIED_SESSION_ID,
      unifiedGraphPlannerAdapter: {
        createExecutionGraph: () => {
          deleted = true;
          return createDocumentLoopProposal();
        },
        id: "stage_refusal_probe",
      },
      userId: accessScope.userId,
      webChatService: createWebChatService(),
    })
  );
  const run = await agentRunService.getRun({ accessScope, runId: response.body.agentRunId });
  const planned = plannedEvents(run);

  assert.equal(response.status, 200);
  assert.deepEqual(planned.map(({ status, supersedes }) => [status, supersedes]), [
    ["selected", null],
    ["rejected", "selected"],
  ]);
  assert.equal(planned[1].errorCodes[0], "stage_refused_before_execution");
  assert.equal(hasUnifiedGuardedGraphPath(run), false);
  assert.equal(
    await agentRunService.getExecutionGraphCheckpoint({ accessScope, runId: run.runId }),
    null
  );
  assert.equal(run.steps.some((step) => step.type === "graph_node"), false);
  assert.ok(run.events.some((event) => event.type === "execution_planned"));
  assert.ok(response.body.agentTrace.some((step) => step.type === "unified_graph_fallback"));
  assert.ok(response.body.agentTrace.some((step) => step.type === "document_rag"));
  assert.equal(run.status, "completed");
});

test("continuing a settled guarded graph run starts a new run and leaves the settled one intact", async () => {
  const agentRunService = newService();
  const first = await ask({
    agentRunService,
    capabilityApprovals: {},
    mode: "guarded",
    proposal: createDocumentLoopProposal,
    question: DOCUMENT_LOOP_QUESTION,
    ragService: createDocumentLoopRagService({ followUp: "unresolved" }),
  });
  assert.equal(first.response.body.agentMode, "clarification");
  assert.equal(first.run.status, "waiting_for_user");
  const settledEvents = first.run.events.length;

  const continued = await ask({
    agentRunId: first.run.runId,
    agentRunService,
    capabilityApprovals: {},
    mode: "guarded",
    proposal: createDocumentLoopProposal,
    question: "Use the renewal clause of the vendor MSA: what notice period does it require?",
    ragService: createDocumentLoopRagService({ followUp: "resolves" }),
  });
  const settled = await agentRunService.getRun({ accessScope, runId: first.run.runId });

  assert.equal(continued.response.status, 200);
  assert.notEqual(continued.run.runId, first.run.runId);
  assert.equal(continued.run.status, "completed");
  assert.deepEqual(
    continued.run.events.find((event) => event.type === "run_continued")?.payload,
    { previousRunId: first.run.runId, reason: "settled_unified_graph_run" }
  );
  assert.equal(continued.run.events.some((event) => event.type === "run_resumed"), false);
  // The new request is a fresh graph, not a re-entry into the old one.
  assert.deepEqual(plannedEvents(continued.run), [
    { errorCodes: [], status: "selected", supersedes: null },
  ]);
  assert.equal(continued.checkpoint.phase, "completed");
  assert.equal(settled.status, "waiting_for_user");
  assert.equal(settled.events.length, settledEvents);

  // A graph that failed part-way settles the run as failed; a continuation
  // is again a new run.
  const failing = createDocumentLoopRagService();
  const failed = newService();
  await assert.rejects(
    ask({
      agentRunService: failed,
      capabilityApprovals: {},
      mode: "guarded",
      proposal: createDocumentLoopProposal,
      question: DOCUMENT_LOOP_QUESTION,
      ragService: {
        ...failing,
        chat: async () => {
          throw new Error("document service unavailable");
        },
      },
    }),
    (error) => error.code === "AGENT_UNIFIED_GRAPH_PARTIAL"
  );
  const [failedRun] = (await failed.listRuns?.({ accessScope }))?.runs ?? [];
  const failedRunId = failedRun?.runId;
  assert.ok(failedRunId);
  assert.equal((await failed.getRun({ accessScope, runId: failedRunId })).status, "failed");
  const retried = await ask({
    agentRunId: failedRunId,
    agentRunService: failed,
    capabilityApprovals: {},
    mode: "guarded",
    proposal: createDocumentLoopProposal,
    question: DOCUMENT_LOOP_QUESTION,
    ragService: createDocumentLoopRagService({ followUp: "resolves" }),
  });
  assert.notEqual(retried.run.runId, failedRunId);
  assert.equal(retried.run.status, "completed");
});

test("a background task continues after a guarded graph clarification", async () => {
  const agentRunService = newService();
  const answers = { followUp: "unresolved" };
  const runner = createAgentTaskRunner({
    runAgentTask: (request) =>
      withEnv({ ...ENV, AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded" }, () =>
        runAgentRag({
          ...request,
          agentRunService,
          ragService: createDocumentLoopRagService({ followUp: answers.followUp }),
          unifiedGraphPlannerAdapter: createProposalAdapter(createDocumentLoopProposal),
          webChatService: createWebChatService(),
        })
      ),
  });
  const task = {
    accessScope,
    input: {
      docIds: [UNIFIED_DOC_ID],
      maxIterations: 2,
      question: DOCUMENT_LOOP_QUESTION,
      sessionId: UNIFIED_SESSION_ID,
      userId: accessScope.userId,
    },
    payload: {
      docIds: [UNIFIED_DOC_ID],
      maxIterations: 2,
      question: DOCUMENT_LOOP_QUESTION,
      sessionId: UNIFIED_SESSION_ID,
      userId: accessScope.userId,
    },
  };

  const waiting = await runner.run({ accessScope, task });
  assert.equal(waiting.status, "waiting_for_user");
  const firstRunId = waiting.payload.pending.agentRunId;
  assert.ok(firstRunId);

  const resumed = await runner.resume({
    action: AGENT_TASK_ACTIONS.continue,
    payload: { answer: "Use the renewal clause of the vendor MSA." },
    task: { ...task, payload: waiting.payload, status: "waiting_for_user" },
  });
  assert.equal(resumed.payload.resumeAgentRunId, true);

  answers.followUp = "resolves";
  const completed = await runner.run({
    accessScope,
    task: { ...task, payload: resumed.payload },
  });

  assert.equal(completed.status, "completed");
  assert.notEqual(completed.payload.agentRunId, firstRunId);
  assert.equal(
    (await agentRunService.getRun({ accessScope, runId: firstRunId })).status,
    "waiting_for_user"
  );
});
