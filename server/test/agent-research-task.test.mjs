import assert from "node:assert/strict";
import test from "node:test";

import {
  compactResearchTaskFlow,
  createResearchTaskFlow,
  isResearchTaskGoal,
  normalizeResearchTaskFlow,
} from "../rag/agent-research-task.js";
import { createAgentWorkflowRegistry } from "../rag/agent-workflows/registry.js";
import {
  RESEARCH_DOSSIER_WORKFLOW_ID,
  createResearchDossierWorkflowSpec,
} from "../rag/agent-workflows/built-ins/research-dossier.js";

test("research task flow renders from the default workflow registry", () => {
  const flow = createResearchTaskFlow({
    docIds: ["doc-a", "doc-b"],
    question: "research_task: 整理这些论文并生成 dossier 风险报告",
  });

  assert.equal(flow.workflow.id, RESEARCH_DOSSIER_WORKFLOW_ID);
  assert.equal(flow.maxIterations, 10);
  assert.equal(flow.status, "running");
  assert.equal(flow.currentPhaseId, "local_research");
  assert.deepEqual(
    flow.phases.map((phase) => [phase.id, phase.status]),
    [
      ["local_research", "running"],
      ["web_supplement", "pending"],
      ["arxiv_supplement", "pending"],
      ["compare_risk_review", "pending"],
      ["citation_self_check", "pending"],
      ["final_dossier", "pending"],
    ]
  );
  assert.equal(
    flow.phases.find((phase) => phase.id === "compare_risk_review")
      .expectedSkill,
    "compare_documents>risk_review"
  );
  assert.match(flow.phases[0].question, /document-grounded research brief/);
  assert.match(flow.phases[3].question, /Compare the selected documents/);
});

test("research task flow resolves single-document workflow phase variants", () => {
  const flow = createResearchTaskFlow({
    docIds: ["doc-a"],
    question: "risk report for this document",
  });
  const reviewPhase = flow.phases.find(
    (phase) => phase.id === "compare_risk_review"
  );

  assert.equal(reviewPhase.label, "Risk review");
  assert.equal(reviewPhase.expectedSkill, "risk_review");
  assert.match(reviewPhase.question, /Perform a citation-backed risk review/);
});

test("research task flow uses injected workflow registry without runner coupling", () => {
  const customWorkflow = {
    ...createResearchDossierWorkflowSpec(),
    id: "custom_research_dossier",
    trigger: {
      keywords: ["bespoke-intel"],
    },
  };
  const workflowRegistry = createAgentWorkflowRegistry({
    workflows: [customWorkflow],
  });

  assert.equal(
    isResearchTaskGoal({ question: "bespoke-intel build" }),
    false
  );
  assert.equal(
    isResearchTaskGoal({
      question: "bespoke-intel build",
      workflowRegistry,
    }),
    true
  );

  const flow = createResearchTaskFlow({
    docIds: ["doc-a"],
    question: "bespoke-intel build",
    workflowRegistry,
  });

  assert.equal(flow.workflow.id, "custom_research_dossier");
  assert.equal(flow.phases[0].id, "local_research");
  assert.match(flow.phases.at(-1).question, /final research dossier/);
});

test("research task compact contract exposes workflow lifecycle without prompts", () => {
  const flow = createResearchTaskFlow({
    docIds: ["doc-a", "doc-b"],
    question: "research_task: Build a dossier.",
  });
  const compactFlow = compactResearchTaskFlow(flow);

  assert.equal(compactFlow.workflow.id, RESEARCH_DOSSIER_WORKFLOW_ID);
  assert.equal(compactFlow.workflow.version, "1.0.0");
  assert.equal(compactFlow.workflow.currentPhaseId, "local_research");
  assert.equal(compactFlow.workflow.status, "running");
  assert.deepEqual(compactFlow.workflow.counts, compactFlow.counts);
  assert.ok(
    compactFlow.workflow.completionChecks.includes(
      "research_phases_completed"
    )
  );
  assert.deepEqual(
    compactFlow.workflow.deliverables.map((deliverable) => [
      deliverable.artifactType,
      deliverable.capabilityId,
    ]),
    [
      ["document_organization", "document.organize"],
      ["markdown_report", "report.export"],
      ["saved_summary", "summary.create"],
      ["follow_up_task", "task.create"],
    ]
  );
  assert.equal(compactFlow.phases[0].question, undefined);
  assert.equal(compactFlow.workflow.phases, undefined);
  assert.equal(compactFlow.workflow.deliverables[0].triggerPatterns, undefined);
  assert.deepEqual(compactFlow.counts, {
    completed: 0,
    failed: 0,
    pending: 5,
    running: 1,
    total: 6,
    waiting: 0,
  });
});

test("research task normalization preserves workflow snapshot only when present", () => {
  assert.equal(
    normalizeResearchTaskFlow({
      phases: [],
      workflow: null,
    }).workflow,
    null
  );

  const flow = createResearchTaskFlow({
    question: "research report",
  });

  assert.equal(
    normalizeResearchTaskFlow(flow).workflow.id,
    RESEARCH_DOSSIER_WORKFLOW_ID
  );
});
