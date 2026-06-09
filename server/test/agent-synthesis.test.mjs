import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDirectAnswerModes,
  buildSynthesisAnswer,
  shouldFinalizeAgentAnswer,
} from "../rag/agent-synthesis.js";
import { SKILL_CHAIN_MODE } from "../rag/agent-planner.js";
import { CUSTOM_SKILL_IDS } from "../rag/skills/registry.js";

test("agent synthesis combines document and web outputs for document_web mode", () => {
  const answer = buildSynthesisAnswer({
    plan: {
      mode: "document_web",
    },
    ragResult: {
      ok: true,
      value: {
        text: " Document answer. ",
      },
    },
    webResult: {
      ok: true,
      value: {
        text: " Web answer. ",
      },
    },
  });

  assert.equal(
    answer,
    "Document evidence:\nDocument answer.\n\nWeb context:\nWeb answer."
  );
});

test("agent synthesis joins successful skill-chain outputs in execution order", () => {
  const answer = buildSynthesisAnswer({
    plan: {
      mode: SKILL_CHAIN_MODE,
    },
    customSkillResults: [
      {
        ok: true,
        text: " First skill output. ",
      },
      {
        ok: false,
        text: "Ignored failed output.",
      },
      {
        ok: true,
        text: "Second skill output.",
      },
    ],
  });

  assert.equal(answer, "First skill output.\n\nSecond skill output.");
});

test("agent synthesis returns matching custom skill output", () => {
  const answer = buildSynthesisAnswer({
    plan: {
      mode: CUSTOM_SKILL_IDS.riskReview,
    },
    customSkillResults: [
      {
        ok: true,
        skillId: CUSTOM_SKILL_IDS.summarizeContract,
        text: "Contract summary.",
      },
      {
        ok: true,
        skillId: CUSTOM_SKILL_IDS.riskReview,
        text: "Risk review.",
      },
    ],
  });

  assert.equal(answer, "Risk review.");
});

test("agent synthesis exposes direct answer modes for selected custom skills", () => {
  const directAnswerModes = buildDirectAnswerModes({
    customSkills: [
      {
        id: CUSTOM_SKILL_IDS.compareDocuments,
      },
    ],
  });

  assert.equal(directAnswerModes.has("inventory"), true);
  assert.equal(directAnswerModes.has("research_brief"), true);
  assert.equal(directAnswerModes.has(SKILL_CHAIN_MODE), true);
  assert.equal(directAnswerModes.has(CUSTOM_SKILL_IDS.compareDocuments), true);
});

test("agent synthesis finalizes only cited document, chain, or primary custom answers", () => {
  assert.equal(
    shouldFinalizeAgentAnswer({
      agentMode: "document",
      ragSources: [
        {
          docId: "doc-1",
        },
      ],
    }),
    true
  );
  assert.equal(
    shouldFinalizeAgentAnswer({
      agentMode: CUSTOM_SKILL_IDS.riskReview,
      primaryCustomResult: {
        skillId: CUSTOM_SKILL_IDS.riskReview,
      },
      ragSources: [
        {
          docId: "doc-1",
        },
      ],
    }),
    true
  );
  assert.equal(
    shouldFinalizeAgentAnswer({
      agentMode: "web",
      ragSources: [
        {
          docId: "doc-1",
        },
      ],
    }),
    false
  );
});
