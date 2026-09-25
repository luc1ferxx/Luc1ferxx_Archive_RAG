import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTION_GRAPH_FAILURE_POLICIES,
  EXECUTION_GRAPH_LIMITS,
} from "../rag/agent-execution-graph.js";
import {
  buildDagPlannerResponseFormat,
  buildDagPlanningContext,
  createAgentExecutionGraphResult,
  dagPlannerAdapter,
} from "../rag/agent-dag-planner-adapter.js";
import { buildIntentPlannerResponseFormat } from "../rag/agent-intent-llm-adapter.js";
import {
  buildPlannerResponseFormat,
  llmPlannerAdapter,
} from "../rag/agent-llm-planner-adapter.js";
import { createChatClient } from "../rag/openai-client.js";
import {
  completeTextWithMetadata,
  configureOpenAIProvider,
  resetOpenAIProvider,
} from "../rag/openai.js";
import { createSkillRegistry } from "../rag/skills/registry.js";
import { extractFirstJsonValue } from "../rag/structured-output.js";

const createTestSkill = (id) => ({
  budgetKey: "customSkillCalls",
  effects: "read_only",
  execute: async () => ({ citations: [], text: "", value: {} }),
  id,
  inputSchema: {
    docIds: { required: true, scoped: true, type: "string[]" },
    priorFindings: { required: false, type: "string" },
    question: { required: true, type: "string" },
  },
  kind: "custom",
  label: id,
  match: () => true,
  outputSchema: {
    abstained: { type: "boolean" },
    citations: { type: "citation[]" },
    text: { type: "string" },
  },
  parallelSafe: true,
  plannerActions: () => [{ id, label: id, summary: "planner action" }],
  plannerSummary: `Summary for ${id}.`,
  requiresAccessScope: true,
  version: "1.0.0",
});

const skills = () => [createTestSkill("compare_documents"), createTestSkill("risk_review")];

const dagContext = () =>
  buildDagPlanningContext({
    authorizedDocIds: ["doc-1", "doc-2"],
    question: "Compare the two contracts and review the risks.",
    selectedSkills: skills(),
  });

const branches = (schema) => schema.anyOf ?? [schema];

const nodeVariant = (format, skillId) =>
  branches(format.json_schema.schema.properties.nodes.items).find((variant) =>
    variant.properties.skillId.enum.includes(skillId)
  );

// Strict structured outputs reject a schema outside this subset, and an
// unbounded string or array lets a small model decode for thousands of tokens.
const assertStrictAndBounded = (schema, path = "$") => {
  for (const branch of schema.anyOf ?? []) {
    assertStrictAndBounded(branch, `${path}|`);
  }

  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, `${path} allows extra keys`);
    assert.deepEqual(
      [...schema.required].sort(),
      Object.keys(schema.properties).sort(),
      `${path} leaves a property optional`
    );
    for (const [key, child] of Object.entries(schema.properties)) {
      assertStrictAndBounded(child, `${path}.${key}`);
    }
  }

  if (schema.type === "array") {
    assert.ok(Number.isInteger(schema.maxItems), `${path} is an unbounded array`);
    assertStrictAndBounded(schema.items, `${path}[]`);
  }

  if (schema.type === "string" && !schema.enum) {
    assert.match(schema.pattern ?? "", /\{\d+,\d+\}\$$/, `${path} is an unbounded string`);
  }
};

test("every planner response format stays inside the bounded strict subset", () => {
  const formats = [
    buildPlannerResponseFormat({
      selectedSkills: [{ id: "document_rag" }, { id: "inventory" }],
      authorizedCustomSkills: [{ id: "compare_documents" }],
    }),
    buildDagPlannerResponseFormat(dagContext()),
    buildIntentPlannerResponseFormat({ candidates: [{ id: "qa" }, { id: "compare_documents" }] }),
  ];

  for (const format of formats) {
    assert.equal(format.type, "json_schema");
    assert.equal(format.json_schema.strict, true);
    assertStrictAndBounded(format.json_schema.schema);
  }
});

test("the execution planner schema offers only this request's steps with their one legal condition", () => {
  const format = buildPlannerResponseFormat({ selectedSkills: [{ id: "document_rag" }] });
  const variants = branches(format.json_schema.schema.properties.steps.items);
  const byId = Object.fromEntries(
    variants.map((variant) => [variant.properties.id.enum[0], variant.properties])
  );

  // document_rag is selected; web_search rides along only as its fallback.
  assert.deepEqual(Object.keys(byId).sort(), ["document_rag", "web_search"]);
  assert.deepEqual(byId.web_search.condition.enum, ["selected_or_document_fallback"]);
  assert.deepEqual(byId.document_rag.skillId.enum, ["document_rag"]);
  assert.equal(format.json_schema.schema.properties.steps.maxItems, 2);
  assert.equal(buildPlannerResponseFormat({ selectedSkills: [] }), null);
});

test("the custom_skills step cannot name a skill; the runtime authorizes those", () => {
  const format = buildPlannerResponseFormat({
    selectedSkills: [],
    authorizedCustomSkills: [{ id: "compare_documents" }],
  });
  const [variant] = branches(format.json_schema.schema.properties.steps.items);

  assert.deepEqual(variant.properties.id.enum, ["custom_skills"]);
  assert.deepEqual(variant.properties.skillId, { type: "null" });
});

test("the DAG schema binds inputs only to type-compatible request fields and outputs", () => {
  const format = buildDagPlannerResponseFormat(dagContext());
  const compare = nodeVariant(format, "compare_documents");
  const bindingFields = (input) =>
    branches(compare.properties.inputBindings.properties[input]).map((branch) =>
      branch.type === "null" ? null : branch.properties.field?.enum ?? branch.properties.output.enum
    );

  // The live failure: a 7B model bound docIds to "authorizedDocIds" and question
  // to "goal", context keys that are not request fields.
  assert.deepEqual(bindingFields("docIds"), [["docIds"]]);
  assert.deepEqual(bindingFields("question"), [["question"], ["text"]]);
  assert.deepEqual(bindingFields("priorFindings"), [["question"], ["text"], null]);
  assert.doesNotMatch(JSON.stringify(format), /authorizedDocIds|"goal"/);

  assert.deepEqual(
    compare.properties.failurePolicy.enum,
    Object.values(EXECUTION_GRAPH_FAILURE_POLICIES)
  );
  assert.deepEqual(branches(compare.properties.scope)[0].properties.docIds.items.enum, ["doc-1", "doc-2"]);
  assert.equal(format.json_schema.schema.properties.nodes.maxItems, EXECUTION_GRAPH_LIMITS.maxNodes);
});

test("the intent schema is the candidate list", () => {
  const format = buildIntentPlannerResponseFormat({
    candidates: [{ id: "qa" }, { id: " compare_documents " }],
  });

  assert.deepEqual(format.json_schema.schema.properties.selectedIntentId.enum, [
    "qa",
    "compare_documents",
  ]);
  assert.equal(buildIntentPlannerResponseFormat({ candidates: [] }), null);
});

test("the chat client sends response_format only when one is given", async (t) => {
  const bodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = createChatClient({ apiKey: "test", model: "test-model" });
  const responseFormat = { json_schema: { name: "x", schema: {}, strict: true }, type: "json_schema" };

  await client.invoke("plan", { responseFormat });
  await client.invoke("plain");

  assert.deepEqual(bodies[0].response_format, responseFormat);
  assert.equal("response_format" in bodies[1], false);
});

test("completeTextWithMetadata forwards the response format unless structured output is off", async (t) => {
  const seen = [];
  configureOpenAIProvider({
    completeText: async (_prompt, options) => {
      seen.push(options?.responseFormat ?? null);
      return "{}";
    },
  });
  const originalFlag = process.env.RAG_STRUCTURED_OUTPUT_ENABLED;
  t.after(() => {
    resetOpenAIProvider();
    if (originalFlag === undefined) delete process.env.RAG_STRUCTURED_OUTPUT_ENABLED;
    else process.env.RAG_STRUCTURED_OUTPUT_ENABLED = originalFlag;
  });
  const responseFormat = { type: "json_schema" };

  delete process.env.RAG_STRUCTURED_OUTPUT_ENABLED;
  await completeTextWithMetadata("plan", { responseFormat });
  process.env.RAG_STRUCTURED_OUTPUT_ENABLED = "false";
  await completeTextWithMetadata("plan", { responseFormat });

  assert.deepEqual(seen, [responseFormat, null]);
});

test("the execution planner asks for its per-request schema", async (t) => {
  let requested = null;
  configureOpenAIProvider({
    completeText: async (_prompt, options) => {
      requested = options?.responseFormat;
      return JSON.stringify({
        steps: [{ condition: "selected_skill", id: "document_rag", reason: null, skillId: "document_rag" }],
      });
    },
  });
  t.after(() => resetOpenAIProvider());

  const plan = await llmPlannerAdapter.createExecutionPlan({ selectedSkills: [{ id: "document_rag" }] });

  assert.equal(requested.json_schema.name, "agent_execution_plan");
  assert.deepEqual(plan.map((step) => step.id), ["document_rag"]);
});

test("a strict-schema DAG proposal with null optional values validates as a graph", async (t) => {
  let requested = null;
  configureOpenAIProvider({
    completeText: async (_prompt, options) => {
      requested = options?.responseFormat;
      const node = (nodeId, skillId, dependsOn, priorFindings) => ({
        dependsOn,
        failurePolicy: "fail_fast",
        inputBindings: {
          docIds: { field: "docIds", source: "request" },
          priorFindings,
          question: { field: "question", source: "request" },
        },
        nodeId,
        rationale: null,
        scope: null,
        skillId,
      });

      return JSON.stringify({
        nodes: [
          node("compare", "compare_documents", [], null),
          node("risk", "risk_review", ["compare"], { nodeId: "compare", output: "text", source: "node" }),
        ],
      });
    },
  });
  t.after(() => resetOpenAIProvider());

  const selectedSkills = skills();
  const result = await createAgentExecutionGraphResult({
    accessScope: { authenticated: true, authProvider: "local", userId: "alice", workspaceId: "acme" },
    authorizedDocIds: ["doc-1", "doc-2"],
    plannerAdapter: dagPlannerAdapter,
    plannerContext: {
      docIds: ["doc-1", "doc-2"],
      plan: { mode: "skill_chain" },
      question: "Compare the two contracts and review the risks.",
      selectedSkills,
    },
    registry: createSkillRegistry(selectedSkills),
    selectedSkills,
  });

  assert.equal(requested.json_schema.name, "agent_execution_graph");
  assert.equal(result.planner.fallback, false, result.planner.fallbackReason);
  assert.deepEqual(result.planner.nodeIds, ["compare", "risk"]);
  const compareNode = result.graph.nodes.find((node) => node.nodeId === "compare");
  assert.equal("priorFindings" in compareNode.inputBindings, false);
  assert.equal("scope" in compareNode, false);
});

test("a planner keeps the first JSON value when the model writes on after it", async (t) => {
  // Verbatim shape of an Ollama + qwen2.5:7b response: the schema held until the
  // object closed, then the model kept going, including stray braces.
  const raw =
    '{"steps":[{"id":"web_search","skillId":"web_search","condition":"selected_or_document_fallback","reason":"Primary step {web}."}]}}利物分析：根据输入 "selected_or_document_fallas" }] }';
  configureOpenAIProvider({ completeText: async () => raw });
  t.after(() => resetOpenAIProvider());

  const plan = await llmPlannerAdapter.createExecutionPlan({ selectedSkills: [{ id: "web_search" }] });

  assert.deepEqual(plan.map((step) => step.id), ["web_search"]);
  assert.equal(extractFirstJsonValue('noise [1, "]", {"a": "}"}] tail ]'), '[1, "]", {"a": "}"}]');
  assert.equal(extractFirstJsonValue('{"unterminated": ['), null);
});

test("the DAG planner is shown the node count its remaining Skill budget can pay for", async (t) => {
  const requested = [];
  configureOpenAIProvider({
    completeText: async (prompt, options) => {
      requested.push({ format: options?.responseFormat, prompt });
      return JSON.stringify({ nodes: [] });
    },
  });
  t.after(() => resetOpenAIProvider());

  const selectedSkills = skills();
  const run = (budgetRemaining) =>
    createAgentExecutionGraphResult({
      accessScope: { authenticated: true, authProvider: "local", userId: "alice", workspaceId: "acme" },
      authorizedDocIds: ["doc-1", "doc-2"],
      budgetRemaining,
      plannerAdapter: dagPlannerAdapter,
      plannerContext: { docIds: ["doc-1", "doc-2"], question: "Compare and review.", selectedSkills },
      registry: createSkillRegistry(selectedSkills),
      selectedSkills,
    });

  await run({ customSkillCalls: 2 });
  await run(null);

  assert.equal(requested[0].format.json_schema.schema.properties.nodes.maxItems, 2);
  assert.match(requested[0].prompt, /"maxNodes":2/);
  assert.equal(
    requested[1].format.json_schema.schema.properties.nodes.maxItems,
    EXECUTION_GRAPH_LIMITS.maxNodes
  );
});
