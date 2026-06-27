import assert from "node:assert/strict";
import test from "node:test";

import {
  createBuiltInAgentWorkflows,
  createDefaultAgentWorkflowRegistry,
} from "../rag/agent-workflows/registry.js";
import {
  renderAgentWorkflowTemplate,
  resolveAgentWorkflowPhase,
  validateAgentWorkflowSpec,
} from "../rag/agent-workflows/schema.js";
import {
  RESEARCH_DOSSIER_WORKFLOW_ID,
  createResearchDossierWorkflowSpec,
} from "../rag/agent-workflows/built-ins/research-dossier.js";
import { CAPABILITY_IDS } from "../rag/capabilities/index.js";

test("research dossier workflow spec is normalized and validates as declarative data", () => {
  const workflow = createResearchDossierWorkflowSpec();
  const validation = validateAgentWorkflowSpec(workflow);

  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(validation.spec.id, RESEARCH_DOSSIER_WORKFLOW_ID);
  assert.equal(validation.spec.type, "agent_workflow");
  assert.deepEqual(
    validation.spec.phases.map((phase) => phase.id),
    [
      "local_research",
      "web_supplement",
      "arxiv_supplement",
      "compare_risk_review",
      "citation_self_check",
      "final_dossier",
    ]
  );
  assert.deepEqual(
    validation.spec.deliverables.map((deliverable) => deliverable.capabilityId),
    [
      CAPABILITY_IDS.documentOrganize,
      CAPABILITY_IDS.reportExport,
      CAPABILITY_IDS.summaryCreate,
      CAPABILITY_IDS.taskCreate,
    ]
  );
  assert.ok(
    validation.spec.completionChecks.includes("research_phases_completed")
  );
  assert.doesNotThrow(() => JSON.stringify(validation.spec));
});

test("default workflow registry lists and selects built-in workflows without exposing mutable state", () => {
  const registry = createDefaultAgentWorkflowRegistry();
  const selected = registry.select({
    question: "research_task: 整理这些论文并生成 dossier 风险报告",
  });

  assert.equal(selected.id, RESEARCH_DOSSIER_WORKFLOW_ID);
  assert.equal(registry.select({ question: "Summarize this document." }), null);

  selected.label = "Mutated label";

  assert.equal(
    registry.get(RESEARCH_DOSSIER_WORKFLOW_ID).label,
    "Research dossier"
  );
  assert.deepEqual(
    registry.list().map((workflow) => workflow.id),
    [RESEARCH_DOSSIER_WORKFLOW_ID]
  );
  assert.deepEqual(
    createBuiltInAgentWorkflows().map((workflow) => workflow.id),
    [RESEARCH_DOSSIER_WORKFLOW_ID]
  );
});

test("research dossier workflow resolves doc-count variants and renders templates", () => {
  const workflow = createResearchDossierWorkflowSpec();
  const comparePhase = workflow.phases.find(
    (phase) => phase.id === "compare_risk_review"
  );
  const multiDocPhase = resolveAgentWorkflowPhase(comparePhase, {
    docIds: ["doc-a", "doc-b"],
  });
  const singleDocPhase = resolveAgentWorkflowPhase(comparePhase, {
    docIds: ["doc-a"],
  });
  const goal = "research_task: Build a risk dossier.";

  assert.equal(multiDocPhase.variantId, "multi_document");
  assert.equal(multiDocPhase.expectedSkill, "compare_documents>risk_review");
  assert.match(
    renderAgentWorkflowTemplate(multiDocPhase.questionTemplate, {
      docIds: ["doc-a", "doc-b"],
      goal,
    }),
    /Compare the selected documents/
  );
  assert.equal(singleDocPhase.variantId, "single_document");
  assert.equal(singleDocPhase.expectedSkill, "risk_review");
  assert.match(
    renderAgentWorkflowTemplate(singleDocPhase.questionTemplate, {
      docIds: ["doc-a"],
      goal,
    }),
    /Perform a citation-backed risk review/
  );

  const finalPhase = workflow.phases.find((phase) => phase.id === "final_dossier");
  const finalQuestion = renderAgentWorkflowTemplate(finalPhase.questionTemplate, {
    goal,
  });

  assert.match(finalQuestion, /Create the final research dossier answer/);
  assert.match(finalQuestion, /Original goal: research_task: Build a risk dossier/);
});

test("workflow validation rejects malformed contracts before registration", () => {
  const invalidWorkflow = {
    ...createResearchDossierWorkflowSpec(),
    deliverables: [
      {
        artifactType: "markdown_report",
      },
    ],
    phases: [
      {
        id: "duplicate",
        label: "Duplicate",
        questionTemplate: "Run this phase.",
      },
      {
        id: "duplicate",
        label: "Duplicate again",
        questionTemplate: "Run this phase too.",
      },
    ],
    trigger: {
      patterns: [
        {
          flags: "i",
          source: "[",
        },
      ],
    },
  };
  const validation = validateAgentWorkflowSpec(invalidWorkflow);

  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some((error) => /Phase id must be unique/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /capabilityId is required/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /regular expression/.test(error)),
    validation.errors.join("\n")
  );

  assert.throws(
    () => createDefaultAgentWorkflowRegistry().register(invalidWorkflow),
    /Invalid agent workflow/
  );
});
