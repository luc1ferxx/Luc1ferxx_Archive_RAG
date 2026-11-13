import assert from "node:assert/strict";
import test from "node:test";

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
  getStepReplaySafetyPolicy,
  isStepRetryAllowed,
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
    "capability_call",
  ]) {
    assert.ok(matrix[stepType], `${stepType} policy is registered`);
    assert.equal(matrix[stepType].retryable, true);
    assert.ok(matrix[stepType].requiredInput.length > 0);
    assert.ok(matrix[stepType].idempotency);
  }

  // The matrix has no "auto replay safe" column: nothing replays a step on
  // its own without an operator.
  for (const policy of Object.values(matrix)) {
    assert.equal("autoReplaySafe" in policy, false, policy.stepType);
  }

  assert.deepEqual(matrix.document_rag.requiredInput, ["docIds", "question"]);
  assert.equal(matrix.document_rag.replayRequiresApproval, false);
  assert.equal(matrix.document_rag.idempotency, STEP_REPLAY_IDEMPOTENCY.memoryWritingRag);
  assert.deepEqual(matrix.document_rag.replayActions, ["retry_failed_step"]);
  for (const stepType of ["follow_up_retrieval", "research_question"]) {
    assert.equal(matrix[stepType].idempotency, STEP_REPLAY_IDEMPOTENCY.memoryWritingRag);
    assert.deepEqual(matrix[stepType].replayActions, ["retry_failed_step"]);
  }

  // A custom Skill step is a graph node: nothing to replay it with, and no
  // action of its own.
  assert.deepEqual(matrix.custom_skill.requiredInput, []);
  assert.deepEqual(matrix.custom_skill.replayActions, []);
  assert.equal(matrix.custom_skill.retryable, false);
  assert.equal(matrix.custom_skill.idempotency, STEP_REPLAY_IDEMPOTENCY.graphOwned);

  assert.deepEqual(matrix.web_search.requiredInput, ["question"]);
  assert.equal(
    matrix.web_search.idempotency,
    STEP_REPLAY_IDEMPOTENCY.externalReadNondeterministic
  );

  assert.deepEqual(matrix.arxiv_import.requiredInput, ["topic"]);
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

test("the step types an operator may retry by hand are derived from the matrix", () => {
  assert.deepEqual(
    listStepReplaySafetyPolicies()
      .map((policy) => policy.stepType)
      .filter(isStepRetryAllowed)
      .sort(),
    [
      "arxiv_import",
      "capability_call",
      "document_rag",
      "follow_up_retrieval",
      "research_question",
      "web_search",
    ]
  );
  assert.equal(isStepRetryAllowed("custom_skill"), false);
  // A type without a policy has no handler either.
  assert.equal(isStepRetryAllowed("graph_node"), false);
  assert.equal(isStepRetryAllowed(""), false);
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
  assert.equal(webHandler.replaySafety.requiredInput[0], "question");
  // One handler per step type the matrix lets an operator retry, and none for
  // a custom Skill step: a custom Skill runs only as a node of its graph.
  assert.deepEqual(
    handlers.map((handler) => handler.id).sort(),
    listStepReplaySafetyPolicies()
      .map((policy) => policy.stepType)
      .filter(isStepRetryAllowed)
      .sort()
  );
  assert.equal(
    registry.resolve({ step: { id: "custom_skill:node", type: "custom_skill" } }),
    null
  );
});

test("step replay safety assessment derives replay reasons from the matrix", () => {
  const memoryWritingDocument = buildStepReplaySafetyAssessment({
    step: {
      id: "step-document",
      input: {
        docIds: ["doc-1"],
        question: "What changed?",
      },
      type: "document_rag",
    },
  });

  assert.deepEqual(memoryWritingDocument.reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
  ]);
  assert.equal(memoryWritingDocument.idempotency, STEP_REPLAY_IDEMPOTENCY.memoryWritingRag);

  const missingDocumentInput = buildStepReplaySafetyAssessment({
    step: {
      id: "step-document-missing",
      input: {
        docIds: ["doc-1"],
      },
      type: "document_rag",
    },
  });

  assert.deepEqual(missingDocumentInput.missingInput, ["question"]);
  assert.deepEqual(missingDocumentInput.reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.missingInput,
    STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
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
 * A `custom_skill` step is the step of a graph node. Whatever the Skill that
 * ran it declared, the step is never replayed on its own; the contract the
 * node persisted with the step only adds what a replay would have risked.
 */
test("a custom_skill step is a graph node whatever its Skill declares", () => {
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

  assert.deepEqual(readOnly.reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.graphNodeStep,
  ]);
  assert.deepEqual(readOnly.missingInput, []);
  assert.deepEqual(readOnly.policy.replayActions, []);
  assert.deepEqual(readOnly.reasons, [
    {
      code: "graph_node_step",
      label: "Graph node",
      message:
        "The step is a node of an execution graph and is never replayed on its own.",
    },
  ]);
  // The assessment no longer carries an auto-replay verdict.
  for (const key of ["autoReplaySafe", "canAutoReplay", "configuredAutoReplaySafe"]) {
    assert.equal(key in readOnly, false, key);
  }

  for (const effects of [
    SKILL_EFFECTS.externalWrite,
    SKILL_EFFECTS.workspaceWrite,
  ]) {
    assert.deepEqual(assess({ effects }).reasonCodes, [
      STEP_REPLAY_SAFETY_REASON_CODES.graphNodeStep,
      STEP_REPLAY_SAFETY_REASON_CODES.externalWrite,
    ]);
  }

  assert.deepEqual(assess({ effects: SKILL_EFFECTS.externalRead }).reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.graphNodeStep,
    STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
  ]);

  // A Skill may be read-only and still refuse replay -- the declaration is the
  // Skill's own.
  assert.deepEqual(
    assess({ effects: SKILL_EFFECTS.readOnly, replaySafe: false }).reasonCodes,
    [
      STEP_REPLAY_SAFETY_REASON_CODES.graphNodeStep,
      STEP_REPLAY_SAFETY_REASON_CODES.unsafeByPolicy,
    ]
  );

  // A step stored without the contract (a step of the deleted V1 chain, or a
  // node from before the contract was persisted) has the type's reason alone.
  assert.deepEqual(assess({}).reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.graphNodeStep,
  ]);
});

/**
 * A step that declares no contract keeps the reasons of its type. A Document
 * RAG step without metadata is not taken for a read-only step: its type says
 * it may write memory.
 */
test("a step that declares no skill contract keeps the reasons of its step type", () => {
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

  assert.deepEqual(documentRag.reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
  ]);
});

test("a stored read-only claim never removes a memory-writing step type's reason", () => {
  for (const type of ["document_rag", "follow_up_retrieval", "research_question"]) {
    const legacy = buildStepReplaySafetyAssessment({
      step: {
        id: `${type}:legacy`,
        input: { docIds: ["doc-1"], question: "What changed?" },
        type,
      },
    });
    const falselySafe = buildStepReplaySafetyAssessment({
      step: {
        id: `${type}:forged-safe`,
        input: {
          docIds: ["doc-1"],
          effects: SKILL_EFFECTS.readOnly,
          question: "What changed?",
          replaySafe: true,
        },
        type,
      },
    });
    const declaredWrite = buildStepReplaySafetyAssessment({
      step: {
        id: `${type}:declared-write`,
        input: {
          docIds: ["doc-1"],
          effects: SKILL_EFFECTS.workspaceWrite,
          question: "What changed?",
          replaySafe: false,
        },
        type,
      },
    });

    assert.deepEqual(legacy.reasonCodes, [
      STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
    ]);
    assert.deepEqual(falselySafe.reasonCodes, [
      STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
    ]);
    assert.deepEqual(declaredWrite.reasonCodes, [
      STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
      STEP_REPLAY_SAFETY_REASON_CODES.externalWrite,
    ]);
  }
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
  assert.equal(actionCapabilityCall.replayRequiresApproval, true);
  assert.deepEqual(actionCapabilityCall.reasonCodes, [
    STEP_REPLAY_SAFETY_REASON_CODES.nonIdempotent,
  ]);
});
