import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_AUTO_RECOVERY_STEP_TYPES,
} from "../rag/agent-run-recovery.js";
import {
  createDefaultAgentRunStepHandlerRegistry,
} from "../rag/agent-run-step-handlers/index.js";
import {
  STEP_REPLAY_APPROVAL_POLICIES,
  STEP_REPLAY_IDEMPOTENCY,
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
