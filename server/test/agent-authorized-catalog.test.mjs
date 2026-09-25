import test from "node:test";
import assert from "node:assert/strict";
import { listAuthorizedAtomicCustomSkills } from "../rag/skills/authorized-catalog.js";
import {
  CUSTOM_SKILL_IDS,
  createDefaultSkillRegistry,
  createSkillRegistry,
} from "../rag/skills/registry.js";

const accessScope = { userId: "alice", workspaceId: "workspace-a" };
const documents = new Map([
  ["doc-a", { docId: "doc-a" }],
  ["doc-b", { docId: "doc-b" }],
]);
const ragService = {
  getDocument: (docId, scope) =>
    scope === accessScope ? documents.get(docId) ?? null : null,
};

test("authorized catalog exposes atomic custom Skills independent of a single selected intent", () => {
  const registry = createDefaultSkillRegistry();
  const legacySelected = registry.select({
    docIds: ["doc-a", "doc-b"],
    plan: { wantsCompareDocuments: true },
  });
  const catalog = listAuthorizedAtomicCustomSkills({
    accessScope,
    docIds: ["doc-a", "doc-b"],
    ragService,
    registry,
  });

  assert.deepEqual(legacySelected.map((skill) => skill.id), [CUSTOM_SKILL_IDS.compareDocuments]);
  assert.equal(catalog.some((skill) => skill.id === CUSTOM_SKILL_IDS.compareDocuments), true);
  assert.equal(catalog.some((skill) => skill.id === CUSTOM_SKILL_IDS.riskReview), true);
  assert.equal(catalog.length, 4);
  assert.equal(catalog.every((skill) => skill.kind === "custom"), true);
});

test("authorized catalog fails closed without a complete scoped document selection", () => {
  const registry = createDefaultSkillRegistry();
  const options = { accessScope, ragService, registry };

  assert.deepEqual(listAuthorizedAtomicCustomSkills({ ...options, docIds: [] }), []);
  assert.deepEqual(listAuthorizedAtomicCustomSkills({ ...options, docIds: ["doc-a", "other-user-doc"] }), []);
  assert.deepEqual(listAuthorizedAtomicCustomSkills({ ...options, docIds: ["doc-a", ""] }), []);
  assert.deepEqual(listAuthorizedAtomicCustomSkills({ ...options, docIds: ["doc-a"], accessScope: null }), []);
  assert.deepEqual(listAuthorizedAtomicCustomSkills({ ...options, docIds: ["doc-a"], ragService: {} }), []);
});

test("authorized catalog never upgrades an untyped V1 Skill to a model-callable Skill", () => {
  const legacySkill = {
    id: "legacy_custom",
    version: "1.0.0",
    label: "Legacy",
    kind: "custom",
    budgetKey: "customSkillCalls",
    requiresAccessScope: true,
    match: () => true,
    execute: async () => ({ text: "legacy" }),
  };
  const registry = createSkillRegistry([legacySkill]);

  assert.deepEqual(
    listAuthorizedAtomicCustomSkills({
      accessScope,
      docIds: ["doc-a"],
      ragService,
      registry,
    }),
    []
  );
});
