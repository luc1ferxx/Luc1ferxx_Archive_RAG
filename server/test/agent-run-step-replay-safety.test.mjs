import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_AUTO_RECOVERY_STEP_TYPES,
} from "../rag/agent-run-recovery.js";
import {
  createDefaultAgentRunStepHandlerRegistry,
} from "../rag/agent-run-step-handlers/index.js";
import {
  CAPABILITY_IDS,
} from "../rag/capabilities/index.js";
import {
  STEP_REPLAY_APPROVAL_POLICIES,
  STEP_REPLAY_IDEMPOTENCY,
  STEP_REPLAY_SAFETY_REASON_CODES,
  buildStepReplaySafetyAssessment,
  getAutoReplaySafeStepTypes,
  getStepReplaySafetyPolicy,
  listStepReplaySafetyPolicies,
} from "../rag/agent-run-step-replay-safety.js";

test("step replay safety matrix fixes contracts for core replay paths", () => {
  const matrix = Object.fromEntries(
    listStepReplaySafetyPolicies().map((policy) => [policy.stepType, policy])
  );

  for (const stepType of [
    "document_rag",
    "web_search",
    "arxiv_import",
    "custom_skill",
    "capability_call",
  ]) {
    assert.ok(matrix[stepType], `${stepType} policy is registered`);
    assert.equal(matrix[stepType].retryable, true);
    assert.ok(matrix[stepType].requiredInput.length > 0);
    assert.ok(matrix[stepType].idempotency);
  }

  assert.deepEqual(matrix.document_rag.requiredInput, ["docIds", "question"]);
  assert.equal(matrix.document_rag.autoReplaySafe, true);
  assert.equal(matrix.document_rag.replayRequiresApproval, false);
  assert.equal(matrix.document_rag.idempotency, STEP_REPLAY_IDEMPOTENCY.readOnlyRag);

  assert.deepEqual(matrix.custom_skill.requiredInput, [
    "docIds",
    "question",
    "skillId",
  ]);
  assert.equal(matrix.custom_skill.autoReplaySafe, true);

  assert.deepEqual(matrix.web_search.requiredInput, ["question"]);
  assert.equal(matrix.web_search.autoReplaySafe, false);
  assert.equal(
    matrix.web_search.idempotency,
    STEP_REPLAY_IDEMPOTENCY.externalReadNondeterministic
  );

  assert.deepEqual(matrix.arxiv_import.requiredInput, ["topic"]);
  assert.equal(matrix.arxiv_import.autoReplaySafe, false);
  assert.equal(matrix.arxiv_import.replayRequiresApproval, true);
  assert.equal(
    matrix.arxiv_import.idempotency,
    STEP_REPLAY_IDEMPOTENCY.dedupedWorkspaceWrite
  );

  assert.deepEqual(matrix.capability_call.requiredInput, [
    "approvedGate.capabilityId",
    "step.input|approvedGate.inputPreview",
  ]);
  assert.equal(
    matrix.capability_call.replayApprovalPolicy,
    STEP_REPLAY_APPROVAL_POLICIES.approvedCapabilityGate
  );
});

test("auto recovery safe step types are derived from replay safety matrix", () => {
  assert.deepEqual([...DEFAULT_AUTO_RECOVERY_STEP_TYPES].sort(), [
    "custom_skill",
    "document_rag",
    "follow_up_retrieval",
    "research_question",
  ]);
  assert.deepEqual(getAutoReplaySafeStepTypes().sort(), [
    "custom_skill",
    "document_rag",
    "follow_up_retrieval",
    "research_question",
  ]);
});

test("step handler registry exposes replay safety contracts", () => {
  const registry = createDefaultAgentRunStepHandlerRegistry();
  const handlers = registry.list();
  const documentHandler = handlers.find((handler) => handler.id === "document_rag");
  const webHandler = handlers.find((handler) => handler.id === "web_search");

  assert.deepEqual(
    documentHandler.replaySafety,
    getStepReplaySafetyPolicy("document_rag")
  );
  assert.equal(webHandler.replaySafety.autoReplaySafe, false);
  assert.equal(webHandler.replaySafety.requiredInput[0], "question");
});

test("step replay safety assessment derives replay reasons from the matrix", () => {
  const safeDocument = buildStepReplaySafetyAssessment({
    step: {
      id: "step-document",
      input: {
        docIds: ["doc-1"],
        question: "What changed?",
      },
      type: "document_rag",
    },
  });

  assert.equal(safeDocument.canAutoReplay, true);
  assert.deepEqual(safeDocument.reasonCodes, []);
  assert.equal(safeDocument.idempotency, STEP_REPLAY_IDEMPOTENCY.readOnlyRag);

  const missingDocumentInput = buildStepReplaySafetyAssessment({
    step: {
      id: "step-document-missing",
      input: {
        docIds: ["doc-1"],
      },
      type: "document_rag",
    },
  });

  assert.equal(missingDocumentInput.canAutoReplay, false);
  assert.deepEqual(missingDocumentInput.missingInput, ["question"]);
  assert.deepEqual(missingDocumentInput.reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.missingInput,
  ]);

  const webSearch = buildStepReplaySafetyAssessment({
    step: {
      id: "step-web",
      input: {
        question: "What changed today?",
      },
      type: "web_search",
    },
  });

  assert.equal(webSearch.canAutoReplay, false);
  assert.deepEqual(webSearch.reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.requiresApproval,
    STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
  ]);

  const arxivImport = buildStepReplaySafetyAssessment({
    step: {
      id: "step-arxiv",
      input: {
        topic: "retrieval augmented generation",
      },
      type: "arxiv_import",
    },
  });

  assert.equal(arxivImport.canAutoReplay, false);
  assert.ok(
    arxivImport.reasonCodes.includes(
      STEP_REPLAY_SAFETY_REASON_CODES.externalWrite
    )
  );
  assert.ok(
    arxivImport.reasonCodes.includes(
      STEP_REPLAY_SAFETY_REASON_CODES.requiresApproval
    )
  );

  const capabilityCall = buildStepReplaySafetyAssessment({
    run: {
      approvalGates: [
        {
          id: "gate-web",
          status: "pending",
        },
      ],
    },
    step: {
      approvalGateId: "gate-web",
      id: "step-capability",
      input: {
        question: "Search the web.",
      },
      type: "capability_call",
    },
  });

  assert.equal(capabilityCall.canAutoReplay, false);
  assert.ok(
    capabilityCall.reasonCodes.includes(
      STEP_REPLAY_SAFETY_REASON_CODES.requiresApproval
    )
  );
  assert.ok(
    capabilityCall.reasonCodes.includes(
      STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent
    )
  );
});

test("action capability replay inherits the capability call safety matrix", () => {
  const actionCapabilityCall = buildStepReplaySafetyAssessment({
    run: {
      approvalGates: [
        {
          capabilityId: CAPABILITY_IDS.taskCreate,
          id: "approval:task.create:1.0.0",
          inputPreview: {
            title: "Review renewal risks",
          },
          status: "approved",
        },
      ],
    },
    step: {
      approvalGateId: "approval:task.create:1.0.0",
      capabilityId: CAPABILITY_IDS.taskCreate,
      id: "step-action-capability",
      input: {
        title: "Review renewal risks",
      },
      type: "capability_call",
    },
  });

  assert.equal(actionCapabilityCall.policy.stepType, "capability_call");
  assert.equal(actionCapabilityCall.canAutoReplay, false);
  assert.equal(actionCapabilityCall.replayRequiresApproval, true);
  assert.deepEqual(actionCapabilityCall.reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
  ]);
});
