import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorizedUnifiedGraphCatalog,
  listAuthorizedUnifiedGraphDescriptors,
} from "../rag/skills/unified-graph-catalog.js";
import { createCapabilityRegistry } from "../rag/capabilities/registry.js";
import { createTaskCreateCapability } from "../rag/capabilities/actions.js";
import { createDocumentDiscoveryCapability } from "../rag/capabilities/documents.js";
import { createWebSearchCapability } from "../rag/capabilities/web.js";
import { CAPABILITY_IDS } from "../rag/capabilities/shared.js";
import { listAuthorizedAtomicCustomSkills } from "../rag/skills/authorized-catalog.js";
import { AGENT_SKILL_IDS, createDefaultSkillRegistry, createSkillRegistry } from "../rag/skills/registry.js";
import {
  SKILL_EFFECTS,
  SKILL_IDEMPOTENCY,
  SKILL_VALUE_TYPES,
  getSkillContract,
  hasExplicitExecutionGraphContract,
  validateSkillValues,
} from "../rag/skills/skill-contract.js";

const accessScope = { userId: "alice", workspaceId: "workspace-a" };
const registry = createDefaultSkillRegistry();
const ragService = {
  getDocument: (docId, scope) =>
    scope === accessScope && ["doc-a", "doc-b"].includes(docId)
      ? { docId }
      : null,
  listDocuments: (scope) =>
    scope === accessScope
      ? [{ docId: "doc-a", fileName: "A.pdf" }, { docId: "doc-b", fileName: "B.pdf" }]
      : [],
};
const capabilityRegistry = createCapabilityRegistry([
  createDocumentDiscoveryCapability({ ragService }),
  createWebSearchCapability({ webChatService: async () => ({ text: "unused" }) }),
  createTaskCreateCapability({
    actionTaskService: { createActionTask: async () => ({ id: "task-1" }) },
  }),
]);

const build = (overrides = {}) =>
  buildAuthorizedUnifiedGraphCatalog({
    accessScope,
    capabilityRegistry,
    docIds: ["doc-a", "doc-b"],
    ragService,
    registry,
    ...overrides,
  });

test("document and Web atomic Skills declare their real typed and replay contracts", () => {
  const document = registry.get(AGENT_SKILL_IDS.documentRag);
  const evidenceCheck = registry.get(AGENT_SKILL_IDS.documentEvidenceCheck);
  const web = registry.get(AGENT_SKILL_IDS.webSearch);

  assert.equal(hasExplicitExecutionGraphContract(document), true);
  assert.equal(hasExplicitExecutionGraphContract(evidenceCheck), true);
  assert.equal(hasExplicitExecutionGraphContract(web), true);
  assert.equal(getSkillContract(document).inputSchema.docIds.scoped, true);
  assert.equal(getSkillContract(document).inputSchema.question.type, SKILL_VALUE_TYPES.string);
  assert.equal(getSkillContract(document).inputSchema.retrievalPlan.required, false);
  assert.equal(getSkillContract(document).outputSchema.citations.type, SKILL_VALUE_TYPES.citationArray);
  assert.equal(getSkillContract(document).outputSchema.evidence.type, SKILL_VALUE_TYPES.object);
  assert.equal(getSkillContract(evidenceCheck).inputSchema.evidence.required, true);
  assert.equal(getSkillContract(evidenceCheck).effects, SKILL_EFFECTS.readOnly);
  assert.equal(getSkillContract(document).effects, SKILL_EFFECTS.workspaceWrite);
  assert.equal(getSkillContract(document).idempotency, SKILL_IDEMPOTENCY.adapterDefined);
  assert.equal(getSkillContract(document).replaySafe, false);
  assert.equal(getSkillContract(web).inputSchema.question.required, true);
  assert.equal(getSkillContract(web).outputSchema.abstained.type, SKILL_VALUE_TYPES.boolean);
  assert.equal(getSkillContract(web).effects, SKILL_EFFECTS.externalRead);
  assert.equal(getSkillContract(web).idempotency, SKILL_IDEMPOTENCY.nondeterministic);
  assert.equal(getSkillContract(web).replaySafe, false);
});

test("metadata Skills declare distinct replay and approval boundaries", () => {
  const inventory = registry.get(AGENT_SKILL_IDS.inventory);
  const discovery = registry.get(AGENT_SKILL_IDS.documentDiscovery);

  assert.equal(hasExplicitExecutionGraphContract(inventory), true);
  assert.equal(hasExplicitExecutionGraphContract(discovery), true);
  assert.equal(getSkillContract(inventory).effects, SKILL_EFFECTS.readOnly);
  assert.equal(getSkillContract(inventory).replaySafe, true);
  assert.equal(getSkillContract(inventory).outputSchema.hasDocuments.type, SKILL_VALUE_TYPES.boolean);
  assert.equal(getSkillContract(discovery).effects, SKILL_EFFECTS.readOnly);
  assert.equal(getSkillContract(discovery).replaySafe, false);
  assert.equal(getSkillContract(discovery).inputSchema.docIds.scoped, true);
  assert.equal(getSkillContract(discovery).outputSchema.matchedDocIds.type, SKILL_VALUE_TYPES.stringArray);
  for (const skillId of [AGENT_SKILL_IDS.arxivImport, AGENT_SKILL_IDS.researchBrief, AGENT_SKILL_IDS.workspaceAction]) {
    assert.equal(hasExplicitExecutionGraphContract(registry.get(skillId)), false, skillId);
  }
});

test("unified catalog describes existing authorized entries without wiring graph execution", () => {
  const catalog = build();
  const ids = catalog.descriptors.map((entry) => entry.id);

  assert.equal(catalog.executionWired, false);
  assert.equal(catalog.skills.length, catalog.descriptors.length);
  assert.equal(ids.includes(AGENT_SKILL_IDS.documentRag), true);
  assert.equal(ids.includes(AGENT_SKILL_IDS.documentEvidenceCheck), true);
  assert.equal(ids.includes(AGENT_SKILL_IDS.webSearch), true);
  assert.equal(ids.includes(AGENT_SKILL_IDS.inventory), true);
  assert.equal(ids.includes(AGENT_SKILL_IDS.documentDiscovery), true);
  assert.equal(ids.includes(AGENT_SKILL_IDS.researchBrief), false);
  assert.equal(ids.includes(AGENT_SKILL_IDS.arxivImport), false);
  assert.equal(ids.includes(AGENT_SKILL_IDS.workspaceAction), false);
  assert.equal(ids.filter((id) => registry.get(id)?.kind === "custom").length, 4);
  assert.equal(catalog.skills.every((skill) => registry.get(skill.id) === skill), true);
  assert.equal(catalog.descriptors.every((entry) => !Object.hasOwn(entry, "execute") && !Object.hasOwn(entry, "match")), true);
  assert.equal(catalog.descriptors.find((entry) => entry.id === AGENT_SKILL_IDS.documentRag).stage, "document_rag_primary");
  assert.equal(catalog.descriptors.find((entry) => entry.id === AGENT_SKILL_IDS.documentEvidenceCheck).stage, "document_evidence_check");
  assert.equal(catalog.descriptors.find((entry) => entry.id === AGENT_SKILL_IDS.inventory).stage, "inventory");
  assert.equal(catalog.descriptors.find((entry) => entry.id === AGENT_SKILL_IDS.documentDiscovery).stage, "document_discovery");
  assert.deepEqual(
    catalog.descriptors.find((entry) => entry.id === AGENT_SKILL_IDS.documentRag).replayPolicy,
    { replaySafe: false, retryable: false }
  );
  assert.deepEqual(
    catalog.descriptors.find((entry) => entry.id === AGENT_SKILL_IDS.webSearch).approval,
    { mode: "user_confirmation", required: true }
  );
  assert.deepEqual(
    catalog.descriptors.find((entry) => entry.id === AGENT_SKILL_IDS.documentDiscovery).approval,
    { mode: "user_confirmation", required: true }
  );
  assert.equal(Object.hasOwn(catalog.descriptors.find((entry) => entry.id === AGENT_SKILL_IDS.inventory), "approval"), false);
  assert.deepEqual(listAuthorizedUnifiedGraphDescriptors({
    accessScope,
    capabilityRegistry,
    docIds: ["doc-a", "doc-b"],
    ragService,
    registry,
  }), catalog.descriptors);
});

test("capability graph adapters are absent by default even when registered", () => {
  const catalog = build();

  assert.equal(catalog.descriptors.some((entry) => entry.id.startsWith("capability:")), false);
  assert.equal(catalog.graphRegistry.get(`capability:${CAPABILITY_IDS.taskCreate}`), null);
  assert.equal(catalog.graphRegistry.get(`capability:${CAPABILITY_IDS.webSearch}`), null);
  assert.deepEqual(catalog.graphRegistry.list().map((skill) => skill.id), catalog.skills.map((skill) => skill.id));
  assert.equal(catalog.graphRegistry.get(AGENT_SKILL_IDS.researchBrief), null);
});

test("trusted capability allowlist admits only the matching explicit adapter", () => {
  const taskId = `capability:${CAPABILITY_IDS.taskCreate}`;
  const webId = `capability:${CAPABILITY_IDS.webSearch}`;
  const catalog = build({ allowedCapabilityIds: [CAPABILITY_IDS.taskCreate] });
  const ids = catalog.descriptors.map((entry) => entry.id);

  assert.equal(ids.includes(taskId), true);
  assert.equal(ids.includes(webId), false);
  assert.equal(ids.includes(AGENT_SKILL_IDS.webSearch), true);
  assert.equal(catalog.graphRegistry.get(taskId), catalog.skills.find((skill) => skill.id === taskId));
  assert.equal(catalog.graphRegistry.get(webId), null);
  assert.deepEqual(catalog.graphRegistry.list().map((skill) => skill.id), catalog.skills.map((skill) => skill.id));
  assert.deepEqual(catalog.descriptors.find((entry) => entry.id === taskId).approval, {
    mode: "user_confirmation",
    required: true,
  });
  assert.equal(catalog.descriptors.find((entry) => entry.id === taskId).stage, "capability");
  assert.equal(catalog.descriptors.every((entry) => !Object.hasOwn(entry, "execute") && !Object.hasOwn(entry, "match")), true);

  const withoutRegisteredTask = build({
    allowedCapabilityIds: [CAPABILITY_IDS.taskCreate],
    capabilityRegistry: createCapabilityRegistry([
      createWebSearchCapability({ webChatService: async () => ({ text: "unused" }) }),
    ]),
  });
  assert.equal(withoutRegisteredTask.graphRegistry.get(taskId), null);
  assert.equal(withoutRegisteredTask.descriptors.some((entry) => entry.id === taskId), false);
});

test("explicit Web capability replaces its legacy built-in planner choice without duplicates", () => {
  const taskId = `capability:${CAPABILITY_IDS.taskCreate}`;
  const webId = `capability:${CAPABILITY_IDS.webSearch}`;

  for (const allowedCapabilityIds of [
    [CAPABILITY_IDS.webSearch],
    [CAPABILITY_IDS.webSearch, CAPABILITY_IDS.webSearch, CAPABILITY_IDS.taskCreate],
  ]) {
    const catalog = build({ allowedCapabilityIds });
    const ids = catalog.descriptors.map((entry) => entry.id);

    assert.equal(ids.filter((id) => id === webId).length, 1);
    assert.equal(ids.includes(AGENT_SKILL_IDS.webSearch), false);
    assert.equal(catalog.graphRegistry.get(AGENT_SKILL_IDS.webSearch), null);
    assert.equal(catalog.graphRegistry.get(webId)?.id, webId);
    assert.equal(ids.includes(taskId), allowedCapabilityIds.includes(CAPABILITY_IDS.taskCreate));
    assert.equal(catalog.graphRegistry.get(taskId)?.id === taskId, allowedCapabilityIds.includes(CAPABILITY_IDS.taskCreate));
    assert.deepEqual(catalog.graphRegistry.list().map((skill) => skill.id), catalog.skills.map((skill) => skill.id));
  }
});

test("unknown and non-explicit capability IDs fail closed", () => {
  const baseline = build().descriptors.map((entry) => entry.id);

  for (const allowedCapabilityIds of [
    ["unknown.capability"],
    [CAPABILITY_IDS.documentDiscovery],
    ["", "unknown.capability", CAPABILITY_IDS.documentDiscovery],
    null,
  ]) {
    const catalog = build({ allowedCapabilityIds });

    assert.deepEqual(catalog.descriptors.map((entry) => entry.id), baseline);
    assert.equal(catalog.graphRegistry.list().some((skill) => skill.id.startsWith("capability:")), false);
  }
});

test("selected-document entries fail closed without affecting verified workspace inventory", () => {
  for (const docIds of [[], ["doc-a", "other"], ["doc-a", ""]]) {
    const { descriptors } = build({ docIds });

    assert.deepEqual(descriptors.map((entry) => entry.id), [AGENT_SKILL_IDS.inventory, AGENT_SKILL_IDS.webSearch]);
  }

  const asyncLookup = { getDocument: async (docId) => ({ docId }) };
  assert.deepEqual(build({ ragService: asyncLookup }).descriptors.map((entry) => entry.id), [AGENT_SKILL_IDS.webSearch]);
  assert.deepEqual(build({ accessScope: null }).descriptors, []);
});

test("inventory and discovery require synchronous, scoped metadata lookup", () => {
  const doesNotList = { getDocument: ragService.getDocument };
  const unverifiedList = {
    getDocument: ragService.getDocument,
    listDocuments: () => [{ docId: "outside", fileName: "Outside.pdf" }],
  };
  const asyncList = {
    getDocument: ragService.getDocument,
    listDocuments: async () => [{ docId: "doc-a" }],
  };

  for (const service of [doesNotList, unverifiedList, asyncList]) {
    const ids = build({ ragService: service }).descriptors.map((entry) => entry.id);

    assert.equal(ids.includes(AGENT_SKILL_IDS.inventory), false);
    assert.equal(ids.includes(AGENT_SKILL_IDS.documentDiscovery), false);
  }
});

test("discovery requires its trusted scoped, approval-gated capability", () => {
  const idsWithoutCapability = build({
    capabilityRegistry: createCapabilityRegistry([
      createWebSearchCapability({ webChatService: async () => ({ text: "unused" }) }),
    ]),
  }).descriptors.map((entry) => entry.id);
  assert.equal(idsWithoutCapability.includes(AGENT_SKILL_IDS.inventory), true);
  assert.equal(idsWithoutCapability.includes(AGENT_SKILL_IDS.documentDiscovery), false);

  const permissiveDiscovery = {
    ...createDocumentDiscoveryCapability({ ragService }),
    approvalPolicy: { mode: "none", userConfirmationRequired: false, writesWorkspace: false },
  };
  const idsWithPermissivePolicy = build({
    capabilityRegistry: createCapabilityRegistry([
      permissiveDiscovery,
      createWebSearchCapability({ webChatService: async () => ({ text: "unused" }) }),
    ]),
  }).descriptors.map((entry) => entry.id);
  assert.equal(idsWithPermissivePolicy.includes(AGENT_SKILL_IDS.documentDiscovery), false);
});

test("metadata Skill raw results satisfy the advertised typed output contracts", async () => {
  const inventory = registry.get(AGENT_SKILL_IDS.inventory);
  const discovery = registry.get(AGENT_SKILL_IDS.documentDiscovery);
  const inventoryOutput = await inventory.execute({ accessScope, ragService });
  const discoveryOutput = await discovery.execute({
    accessScope,
    capabilityRegistry: {
      execute: async (id, payload) => {
        assert.equal(id, "workspace.document_discovery");
        assert.equal(payload.accessScope, accessScope);
        assert.deepEqual(payload.input.docIds, ["doc-a"]);
        return {
          matches: [
            { document: { docId: "doc-a", fileName: "A.pdf" }, score: 1 },
            { document: { docId: "doc-b", fileName: "B.pdf" }, score: 1 },
          ],
        };
      },
    },
    docIds: ["doc-a"],
    question: "Find A",
  });

  assert.deepEqual(validateSkillValues({ output: inventoryOutput, schema: getSkillContract(inventory).outputSchema }).errors, []);
  assert.equal(inventoryOutput.documentCount, 2);
  assert.deepEqual(validateSkillValues({ output: discoveryOutput, schema: getSkillContract(discovery).outputSchema }).errors, []);
  assert.deepEqual(discoveryOutput.matchedDocIds, ["doc-a"]);
  assert.doesNotMatch(discoveryOutput.text, /B\.pdf/);
});

test("Web entry requires the trusted approval-gated external capability", () => {
  assert.equal(build({ capabilityRegistry: null }).descriptors.some((entry) => entry.id === AGENT_SKILL_IDS.webSearch), false);

  const permissiveCapability = {
    ...createWebSearchCapability({ webChatService: async () => ({ text: "unused" }) }),
    approvalPolicy: { mode: "none", userConfirmationRequired: false, writesWorkspace: false },
  };
  const permissiveRegistry = createCapabilityRegistry([permissiveCapability]);
  assert.equal(build({ capabilityRegistry: permissiveRegistry }).descriptors.some((entry) => entry.id === AGENT_SKILL_IDS.webSearch), false);
});

test("unified catalog does not infer missing replay policy from a legacy custom entry", () => {
  const partialCustom = {
    id: "partial_custom",
    version: "1.0.0",
    label: "Partial custom",
    kind: "custom",
    budgetKey: "customSkillCalls",
    requiresAccessScope: true,
    effects: SKILL_EFFECTS.readOnly,
    inputSchema: {
      docIds: { required: true, scoped: true, type: SKILL_VALUE_TYPES.stringArray },
    },
    outputSchema: {
      text: { required: true, type: SKILL_VALUE_TYPES.string },
    },
    match: () => true,
    execute: async () => ({ text: "unused" }),
  };
  const partialRegistry = createSkillRegistry([partialCustom]);
  const options = { accessScope, docIds: ["doc-a"], ragService, registry: partialRegistry };

  assert.deepEqual(listAuthorizedAtomicCustomSkills(options), [partialCustom]);
  assert.deepEqual(build({ registry: partialRegistry }).descriptors, []);
});
