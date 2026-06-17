import test from "node:test";
import assert from "node:assert/strict";
import {
  formatTrajectoryReportMarkdown,
  runTrajectoryEvaluation,
} from "../evaluation/trajectory-eval.js";

test("trajectory eval passes default deterministic agent trajectories", async () => {
  const report = await runTrajectoryEvaluation({
    createdAt: "2026-06-09T00:00:00.000Z",
    runId: "trajectory-test",
  });

  assert.equal(report.summary.status, "pass");
  assert.equal(report.summary.metrics.caseCount, 12);
  assert.equal(report.summary.metrics.failedCaseCount, 0);
  assert.equal(report.summary.metrics.categories.skill_selection.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.follow_up.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.clarification.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.access_scope.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.budget.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.approval.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.retry.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.memory.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.conflict.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.planner.failedCheckCount, 0);
  assert.equal(report.summary.metrics.categories.privacy.failedCheckCount, 0);
  assert.ok(
    report.cases.some(
      (caseResult) =>
        caseResult.id === "skill_chain_contract_review" &&
        caseResult.response.skillChain
          .map((skill) => skill.skillId)
          .join(">") === "summarize_contract>risk_review"
    )
  );
  assert.ok(
    report.cases.some(
      (caseResult) =>
        caseResult.id === "document_follow_up_retrieval" &&
        caseResult.response.traceTypes.includes("follow_up_retrieval")
    )
  );
  assert.ok(
    report.cases.some(
      (caseResult) =>
        caseResult.id === "capability_approval_resume" &&
        caseResult.response.agentMode === "web" &&
        caseResult.response.traceTypes.includes("capability_approval_gate")
    )
  );
  assert.ok(
    report.cases.some(
      (caseResult) =>
        caseResult.id === "custom_skill_retry" &&
        caseResult.response.agentMode === "risk_review"
    )
  );
  assert.ok(
    report.cases.some(
      (caseResult) =>
        caseResult.id === "memory_not_evidence" &&
        caseResult.response.workingMemory.unsupportedClaimCount > 0
    )
  );
  assert.ok(report.cases.some((caseResult) => caseResult.id === "web_approval_deny"));
  assert.ok(
    report.cases.some(
      (caseResult) =>
        caseResult.id === "multi_doc_conflict" &&
        caseResult.response.agentMode === "compare_documents"
    )
  );
  assert.ok(report.cases.some((caseResult) => caseResult.id === "planner_fallback"));
  assert.ok(report.cases.some((caseResult) => caseResult.id === "privacy_sanitization"));
});

test("trajectory eval markdown summarizes categories and failed checks", async () => {
  const report = await runTrajectoryEvaluation({
    createdAt: "2026-06-09T00:00:00.000Z",
    runId: "trajectory-test",
  });
  const markdown = formatTrajectoryReportMarkdown(report);

  assert.match(markdown, /AgentRAG Trajectory Eval/);
  assert.match(markdown, /Skill selection/);
  assert.match(markdown, /Approval/);
  assert.match(markdown, /Follow-up/);
  assert.match(markdown, /Retry/);
  assert.match(markdown, /Memory/);
  assert.match(markdown, /Conflict/);
  assert.match(markdown, /Planner/);
  assert.match(markdown, /Privacy/);
  assert.match(markdown, /Contract review skill chain/);
  assert.match(markdown, /Capability approval resume/);
  assert.match(markdown, /Custom skill retry/);
  assert.match(markdown, /Privacy sanitization/);
  assert.match(markdown, /PASS/);
});
