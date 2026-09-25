import test from "node:test";
import assert from "node:assert/strict";

import { projectUnifiedGraphRun } from "../rag/agent-unified-graph-projection.js";
import { createDefaultSkillRegistry, AGENT_SKILL_IDS } from "../rag/skills/registry.js";

const registry = createDefaultSkillRegistry();
const customSkill = registry.get("risk_review");

const makeResult = (skill, { text, citations = [], abstained = false, value } = {}) => ({
  ok: true,
  skillId: skill.id,
  skillVersion: skill.version,
  label: skill.label,
  value: value ?? { text, citations, abstained },
  text,
  citations,
  abstained,
  traceDetail: null,
  graphOutput: {
    text,
    citations,
    abstained,
    ...(skill.id === AGENT_SKILL_IDS.documentRag
      ? { evidence: {
          text: value?.text ?? text,
          citations: value?.citations ?? citations,
          abstained: value?.abstained ?? abstained,
          retrievedContexts: value?.retrievedContexts ?? [],
          comparisonAnalysisSummary: value?.comparisonAnalysisSummary ?? null,
        } }
      : {}),
    ...(skill.id === AGENT_SKILL_IDS.inventory
      ? { documentCount: 1, hasDocuments: true }
      : {}),
    ...(skill.id === AGENT_SKILL_IDS.documentDiscovery
      ? { matchedDocIds: ["doc-a"], hasMatches: true }
      : {}),
  },
});

const makeGraphRun = (entries, overrides = {}) => ({
  graph: {
    version: "v3",
    revision: 0,
    nodes: entries.map(({ nodeId, skill }) => ({ nodeId, skillId: skill.id })),
  },
  run: {
    graphVersion: "v3",
    ok: true,
    status: "completed",
    nodeRuns: entries.map(({ nodeId, skill, result }) => ({
      nodeId,
      skillId: skill.id,
      skillVersion: skill.version,
      status: "completed",
      result,
    })),
    results: entries.map(({ result }) => result),
  },
  registry,
  ...overrides,
});

const assertProjectionError = (project) =>
  assert.throws(project, (error) =>
    error.code === "AGENT_UNIFIED_GRAPH_PROJECTION_INVALID" && error.status === 409
  );

test("projects heterogeneous v3 results to the legacy fields without copying RAG or Web envelopes", () => {
  const document = registry.get(AGENT_SKILL_IDS.documentRag);
  const web = registry.get(AGENT_SKILL_IDS.webSearch);
  const documentValue = {
    text: "Document answer",
    citations: [{ docId: "doc-a", chunkId: "chunk-a" }],
    abstained: false,
    resolvedQuery: "resolved question",
    retrievedContexts: [{ docId: "doc-a", text: "evidence" }],
  };
  const documentResult = makeResult(document, {
    text: documentValue.text,
    citations: documentValue.citations,
    value: documentValue,
  });
  const customResult = makeResult(customSkill, {
    text: "Risk finding",
    citations: [{ docId: "doc-a", chunkId: "chunk-b" }],
  });
  const webResult = makeResult(web, {
    text: "Web answer",
    value: { text: "Web answer" },
  });
  const input = makeGraphRun([
    { nodeId: "document", skill: document, result: documentResult },
    { nodeId: "risk", skill: customSkill, result: customResult },
    { nodeId: "web", skill: web, result: webResult },
  ]);

  const state = projectUnifiedGraphRun(input);

  assert.equal(state.ragResult, documentResult);
  assert.equal(state.ragResult.value, documentValue);
  assert.equal(state.documentRagSkill, document);
  assert.equal(state.webResult, webResult);
  assert.equal(state.webResult.value.text, "Web answer");
  assert.equal(state.shouldRunWeb, true);
  assert.deepEqual(state.customSkillResults, [customResult]);
  assert.deepEqual(state.customSkills, [customSkill]);
  assert.equal(state.customSkillGraphExecuted, true);
  assert.equal(state.documentEvidenceClarification, null);
  assert.equal(state.researchBrief, null);
  assert.equal(state.actionAnswer, null);
});

test("allows repeated custom Skills as distinct nodes while rejecting repeated document or Web stage outputs", () => {
  const first = makeResult(customSkill, { text: "Risk A" });
  const second = makeResult(customSkill, { text: "Risk B" });
  const customState = projectUnifiedGraphRun(makeGraphRun([
    { nodeId: "risk-a", skill: customSkill, result: first },
    { nodeId: "risk-b", skill: customSkill, result: second },
  ]));

  assert.deepEqual(customState.customSkillResults, [first, second]);
  assert.deepEqual(customState.customSkills, [customSkill]);

  for (const skillId of [AGENT_SKILL_IDS.documentRag, AGENT_SKILL_IDS.webSearch]) {
    const skill = registry.get(skillId);
    const value = skillId === AGENT_SKILL_IDS.documentRag
      ? { text: "Answer", citations: [], abstained: false }
      : { text: "Answer" };
    const result = makeResult(skill, { text: "Answer", value });
    assertProjectionError(() => projectUnifiedGraphRun(makeGraphRun([
      { nodeId: "first", skill, result },
      { nodeId: "second", skill, result },
    ])));
  }
});

test("rejects duplicate node receipts, mismatched result lists, and unrecognized graph status", () => {
  const result = makeResult(customSkill, { text: "Risk" });
  const input = makeGraphRun([{ nodeId: "risk", skill: customSkill, result }]);

  assertProjectionError(() => projectUnifiedGraphRun({
    ...input,
    run: { ...input.run, nodeRuns: [...input.run.nodeRuns, ...input.run.nodeRuns] },
  }));
  assertProjectionError(() => projectUnifiedGraphRun({
    ...input,
    run: { ...input.run, results: [makeResult(customSkill, { text: "Other" })] },
  }));
  assertProjectionError(() => projectUnifiedGraphRun({
    ...input,
    run: { ...input.run, ok: false, status: "partial" },
  }));
  assertProjectionError(() => projectUnifiedGraphRun({
    ...input,
    graph: { ...input.graph, nodes: [...input.graph.nodes, ...input.graph.nodes] },
    run: { ...input.run, nodeRuns: [...input.run.nodeRuns, ...input.run.nodeRuns] },
  }));
});

test("ignores a validated false branch without inventing a Web result", () => {
  const document = registry.get(AGENT_SKILL_IDS.documentRag);
  const web = registry.get(AGENT_SKILL_IDS.webSearch);
  const documentResult = makeResult(document, {
    text: "Document answer",
    value: { text: "Document answer", citations: [], abstained: false },
  });
  const input = makeGraphRun([
    { nodeId: "document", skill: document, result: documentResult },
    { nodeId: "web", skill: web, result: makeResult(web, { text: "Unused" }) },
  ]);
  input.run.nodeRuns[1] = {
    nodeId: "web",
    skillId: web.id,
    skillVersion: web.version,
    status: "skipped",
    reason: "condition_not_met",
    result: null,
  };
  input.run.results = [documentResult];

  const state = projectUnifiedGraphRun(input);
  assert.equal(state.ragResult, documentResult);
  assert.equal(state.webResult, null);
  assert.equal(state.shouldRunWeb, false);
});

test("rejects missing or inconsistent typed envelopes and legacy RAG values", () => {
  const document = registry.get(AGENT_SKILL_IDS.documentRag);
  const valid = makeResult(document, {
    text: "Answer",
    value: { text: "Answer", citations: [], abstained: false },
  });
  for (const invalid of [
    { ...valid, graphOutput: null },
    { ...valid, graphOutput: { ...valid.graphOutput, text: "Another answer" } },
    { ...valid, graphOutput: { ...valid.graphOutput, undeclared: "extra" } },
    { ...valid, value: undefined },
    { ...valid, value: { text: "Answer" } },
    { ...valid, value: { text: "Answer", citations: [], abstained: true } },
    { ...valid, graphOutput: { ...valid.graphOutput, evidence: {
      ...valid.graphOutput.evidence,
      text: "Conflicting evidence",
    } } },
    { ...valid, graphOutput: { ...valid.graphOutput, evidence: {
      ...valid.graphOutput.evidence,
      retrievedContexts: [{ docId: "doc-a", text: "Conflicting context" }],
    } } },
  ]) {
    assertProjectionError(() => projectUnifiedGraphRun(makeGraphRun([
      { nodeId: "document", skill: document, result: invalid },
    ])));
  }

  const web = registry.get(AGENT_SKILL_IDS.webSearch);
  const webResult = makeResult(web, { text: "Web answer", value: { text: "Other" } });
  assertProjectionError(() => projectUnifiedGraphRun(makeGraphRun([
    { nodeId: "web", skill: web, result: webResult },
  ])));
});

test("rejects unsupported built-ins instead of folding them into custom results", () => {
  const document = registry.get(AGENT_SKILL_IDS.documentRag);
  const unsupported = {
    ...document,
    id: AGENT_SKILL_IDS.researchBrief,
    label: "Research Brief",
  };
  const localRegistry = { get: (skillId) => skillId === unsupported.id ? unsupported : null };
  const result = makeResult(unsupported, {
    text: "Brief",
    value: { text: "Brief", citations: [], abstained: false },
  });

  assertProjectionError(() => projectUnifiedGraphRun(makeGraphRun([
    { nodeId: "brief", skill: unsupported, result },
  ], { registry: localRegistry })));

  const skipped = makeGraphRun([
    { nodeId: "risk", skill: customSkill, result: makeResult(customSkill, { text: "Risk" }) },
    { nodeId: "brief", skill: unsupported, result },
  ], { registry: { get: (id) => id === unsupported.id ? unsupported : registry.get(id) } });
  skipped.run.nodeRuns[1] = {
    nodeId: "brief",
    skillId: unsupported.id,
    skillVersion: unsupported.version,
    status: "skipped",
    reason: "condition_not_met",
    result: null,
  };
  skipped.run.results = [skipped.run.nodeRuns[0].result];
  assertProjectionError(() => projectUnifiedGraphRun(skipped));
});

test("direct inventory/discovery projection requires live typed output and a matching standalone plan", () => {
  for (const skillId of [AGENT_SKILL_IDS.inventory, AGENT_SKILL_IDS.documentDiscovery]) {
    const current = registry.get(skillId);
    const currentResult = makeResult(current, { text: "Listing" });
    const input = makeGraphRun([
      { nodeId: "direct", skill: current, result: currentResult },
    ], { plan: { mode: skillId } });
    const state = projectUnifiedGraphRun(input);
    assert.equal(skillId === AGENT_SKILL_IDS.inventory ? state.inventoryAnswer : state.discoveryAnswer, "Listing");

    assertProjectionError(() => projectUnifiedGraphRun(makeGraphRun([
      { nodeId: "direct", skill: current, result: {
        ...currentResult,
        graphOutput: { text: "Listing", citations: [], abstained: false },
      } },
    ], { plan: { mode: skillId } })));

    assertProjectionError(() => projectUnifiedGraphRun({ ...input, plan: { mode: "document" } }));
    const customResult = makeResult(customSkill, { text: "Risk" });
    assertProjectionError(() => projectUnifiedGraphRun(makeGraphRun([
      { nodeId: "direct", skill: current, result: currentResult },
      { nodeId: "risk", skill: customSkill, result: customResult },
    ], { plan: { mode: skillId } })));
  }
});
