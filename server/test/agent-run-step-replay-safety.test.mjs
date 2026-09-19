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
import { SKILL_EFFECTS } from "../rag/skills/skill-contract.js";

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
    "approvedGate.approvalObjectHash",
    "step.approvalGateId",
    "step.detail.approvalObjectHash",
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
          capabilityId: CAPABILITY_IDS.webSearch,
          id: "gate-web",
          status: "pending",
        },
      ],
    },
    step: {
      approvalGateId: "gate-web",
      id: "step-capability",
      input: null,
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
      STEP_REPLAY_SAFETY_REASON_CODES.missingInput
    )
  );
  assert.ok(
    capabilityCall.reasonCodes.includes(
      STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent
    )
  );

  const mismatchedApprovalHash = buildStepReplaySafetyAssessment({
    run: {
      approvalGates: [
        {
          approvalObjectHash: `sha256:${"a".repeat(64)}`,
          capabilityId: CAPABILITY_IDS.webSearch,
          id: "gate-web-mismatch",
          status: "approved",
        },
      ],
    },
    step: {
      approvalGateId: "gate-web-mismatch",
      detail: {
        approvalObjectHash: `sha256:${"b".repeat(64)}`,
      },
      id: "step-capability-mismatch",
      input: null,
      type: "capability_call",
    },
  });

  assert.ok(
    mismatchedApprovalHash.reasonCodes.includes(
      STEP_REPLAY_SAFETY_REASON_CODES.requiresApproval
    )
  );
  assert.equal(
    mismatchedApprovalHash.reasonCodes.includes(
      STEP_REPLAY_SAFETY_REASON_CODES.missingInput
    ),
    false
  );
});

/**
 * The custom_skill policy was written when one such step meant one whitelisted
 * read-only skill, so declaring the whole step type auto-replay-safe was true by
 * construction. The typed skill contract admits external_write and
 * workspace_write skills into that same step type, and a graph node runs one of
 * them under exactly the same step type as a RAG read. The step type is
 * therefore no longer sufficient on its own: the contract persisted with the
 * step has to be able to narrow it.
 */
test("a step whose persisted contract declares a side effect is never auto-replayed", () => {
  const assess = (input) =>
    buildStepReplaySafetyAssessment({
      step: {
        id: "custom_skill:node",
        input: {
          docIds: ["doc-1"],
          question: "Which obligations changed?",
          skillId: "some_skill",
          ...input,
        },
        type: "custom_skill",
      },
    });

  const readOnly = assess({
    effects: SKILL_EFFECTS.readOnly,
    replaySafe: true,
  });

  assert.equal(readOnly.canAutoReplay, true);
  assert.deepEqual(readOnly.reasonCodes, []);

  for (const effects of [
    SKILL_EFFECTS.externalWrite,
    SKILL_EFFECTS.workspaceWrite,
  ]) {
    const writing = assess({ effects });

    assert.equal(writing.canAutoReplay, false, `${effects} is not auto-replayed`);
    assert.deepEqual(writing.reasonCodes, [
      STEP_REPLAY_SAFETY_REASON_CODES.externalWrite,
    ]);
  }

  const externalRead = assess({ effects: SKILL_EFFECTS.externalRead });

  assert.equal(externalRead.canAutoReplay, false);
  assert.deepEqual(externalRead.reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
  ]);

  // A skill may be read-only and still refuse replay -- the declaration is the
  // skill's own, and the recovery layer has no standing to overrule it.
  const refusesReplay = assess({
    effects: SKILL_EFFECTS.readOnly,
    replaySafe: false,
  });

  assert.equal(refusesReplay.canAutoReplay, false);
  assert.deepEqual(refusesReplay.reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.unsafeByPolicy,
  ]);
});

/**
 * Narrowing only. Every step persisted before the typed contract existed -- and
 * every step type that never carried one -- keeps the verdict it has today,
 * because an absent declaration is not evidence of a side effect.
 */
test("a step that declares no skill contract keeps its step-type verdict", () => {
  const legacyCustomSkill = buildStepReplaySafetyAssessment({
    step: {
      id: "custom_skill:risk_review",
      input: {
        docIds: ["doc-1"],
        question: "Which obligations changed?",
        skillId: "risk_review",
      },
      type: "custom_skill",
    },
  });

  assert.equal(legacyCustomSkill.canAutoReplay, true);
  assert.deepEqual(legacyCustomSkill.reasonCodes, []);

  const documentRag = buildStepReplaySafetyAssessment({
    step: {
      id: "document_rag",
      input: {
        docIds: ["doc-1"],
        question: "Which obligations changed?",
      },
      type: "document_rag",
    },
  });

  assert.equal(documentRag.canAutoReplay, true);
  assert.deepEqual(documentRag.reasonCodes, []);
});

test("action capability replay inherits the capability call safety matrix", () => {
  const actionCapabilityCall = buildStepReplaySafetyAssessment({
    run: {
      approvalGates: [
        {
          approvalObjectHash: `sha256:${"a".repeat(64)}`,
          capabilityId: CAPABILITY_IDS.taskCreate,
          id: "approval:task.create:1.0.0",
          status: "approved",
        },
      ],
    },
    step: {
      approvalGateId: "approval:task.create:1.0.0",
      capabilityId: CAPABILITY_IDS.taskCreate,
      detail: {
        approvalObjectHash: `sha256:${"a".repeat(64)}`,
      },
      id: "step-action-capability",
      input: null,
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
