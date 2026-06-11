import test from "node:test";
import assert from "node:assert/strict";
import {
  appendCaseCheckTable,
  appendCategoryMetricsTable,
  buildCheck,
  buildMetricSummary,
  buildScopedRagService,
  buildSource,
  createAccessScopeMatcher,
  createCaseFinisher,
  createEvalTelemetry,
  runCaseSafely,
} from "../evaluation/agent-eval-harness.js";

test("agent eval harness scopes rag service calls and records telemetry", async () => {
  const expectedScope = {
    userId: "user-1",
    workspaceId: "workspace-1",
  };
  const telemetry = createEvalTelemetry();
  const ragService = buildScopedRagService({
    chat: async ({ callIndex, docIds, options, question }) => ({
      callIndex,
      docIds,
      question,
      scope: options.accessScope,
    }),
    documents: [
      {
        docId: "doc-1",
      },
    ],
    sameScope: createAccessScopeMatcher(expectedScope),
    telemetry,
  });

  assert.deepEqual(ragService.listDocuments(expectedScope), [{ docId: "doc-1" }]);
  assert.deepEqual(
    ragService.listDocuments({
      userId: "other-user",
      workspaceId: "workspace-1",
    }),
    []
  );

  const response = await ragService.chat(["doc-1"], "What changed?", {
    accessScope: expectedScope,
    retrievalPlan: {
      intent: "fact",
    },
  });

  assert.equal(response.callIndex, 1);
  assert.deepEqual(telemetry.listDocumentScopes, [
    expectedScope,
    {
      userId: "other-user",
      workspaceId: "workspace-1",
    },
  ]);
  assert.deepEqual(telemetry.chatCalls, [
    {
      accessScope: expectedScope,
      docIds: ["doc-1"],
      question: "What changed?",
      retrievalPlan: {
        intent: "fact",
      },
    },
  ]);
});

test("agent eval harness finishes failed cases through the response summary", async () => {
  const finishCase = createCaseFinisher({
    buildResponseSummary: ({ response, telemetry }) => ({
      status: response?.status ?? null,
      telemetryCount: telemetry.chatCalls.length,
    }),
  });
  const caseResult = await runCaseSafely(
    {
      id: "throws",
      label: "Throwing case",
      description: "The harness should convert thrown errors into failed checks.",
      run: async () => {
        throw new Error("boom");
      },
    },
    {
      errorCategory: "execution",
      finishCase,
    }
  );

  assert.equal(caseResult.passed, false);
  assert.equal(caseResult.failedCheckCount, 1);
  assert.deepEqual(caseResult.response, {
    status: null,
    telemetryCount: 0,
  });
  assert.deepEqual(caseResult.checks, [
    {
      category: "execution",
      detail: "boom",
      id: "case_error",
      label: "Case completed without throwing",
      passed: false,
    },
  ]);
});

test("agent eval harness summarizes metrics and markdown tables", () => {
  const passCheck = buildCheck({
    category: "planner",
    id: "planner_ok",
    label: "Planner selected",
    passed: true,
  });
  const failCheck = buildCheck({
    category: "execution",
    detail: "missing trace",
    id: "execution_failed",
    label: "Execution trace ran",
    passed: false,
  });
  const metrics = buildMetricSummary({
    caseResults: [
      {
        checks: [passCheck, failCheck],
        passed: false,
      },
      {
        checks: [passCheck],
        passed: true,
      },
    ],
    categoryLabels: {
      execution: "Execution",
      planner: "Planner",
    },
  });
  const lines = [];

  appendCategoryMetricsTable({
    categories: metrics.categories,
    lines,
  });
  appendCaseCheckTable({
    categoryLabels: {
      execution: "Execution",
      planner: "Planner",
    },
    checks: [passCheck, failCheck],
    lines,
  });

  assert.equal(metrics.caseCount, 2);
  assert.equal(metrics.failedCaseCount, 1);
  assert.equal(metrics.checkCount, 3);
  assert.equal(metrics.failedCheckCount, 1);
  assert.equal(metrics.overallPassRate, 0.5);
  assert.equal(metrics.checkPassRate, 0.6667);
  assert.equal(metrics.categories.planner.passRate, 1);
  assert.equal(metrics.categories.execution.passRate, 0);
  assert.match(lines.join("\n"), /Planner/);
  assert.match(lines.join("\n"), /Execution trace ran/);
});

test("agent eval harness builds stable citation-like sources", () => {
  assert.deepEqual(
    buildSource({
      excerpt: "Source excerpt.",
    }),
    {
      docId: "doc-1",
      excerpt: "Source excerpt.",
      fileName: "document.pdf",
      pageNumber: 1,
    }
  );
});
