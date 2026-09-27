import { createHash } from "node:crypto";

import {
  EXECUTION_GRAPH_BINDING_SOURCES,
  EXECUTION_GRAPH_FAILURE_POLICIES,
  EXECUTION_GRAPH_LIMITS,
  EXECUTION_GRAPH_VERSIONS,
} from "./agent-execution-graph.js";
import { parsePlannerJson } from "./agent-dag-planner-adapter.js";
import { completeTextWithMetadata } from "./openai.js";
import { definePrompt, PROMPT_IDS } from "./prompt-registry.js";
import { MODEL_CAPABILITIES, MODEL_ROUTE_IDS } from "./model-providers/index.js";
import { getActiveRunUsage, getRunPromptUsage } from "./run-usage.js";
import { AGENT_SKILL_IDS } from "./skills/built-ins.js";
import {
  EXECUTION_REQUEST_FIELD_TYPES,
  SKILL_VALUE_TYPES,
} from "./skills/skill-contract.js";
import {
  boundedArray,
  boundedString,
  buildJsonSchemaResponseFormat,
  identifierString,
  nullable,
  oneOfSchemas,
  strictObject,
  stringEnum,
} from "./structured-output.js";
import { normalizeText } from "../lib/normalize-text.js";

// Planner adapters for the heterogeneous v3 graph (agent-unified-dag-planner.js
// owns the boundary that validates what they return).
//
// The model adapter follows the other planners: a registered prompt, a strict
// JSON Schema response_format built per request from the runtime-authorized
// catalog (one node variant per catalog entry, its own typed inputs bound only
// to a request field or an upstream output of an assignable type; every string
// bounded with `pattern`, every array with maxItems), and the first complete
// JSON value of the reply. The schema only narrows what the model can say: the
// validator and admission stay the final authority, and a proposal they refuse
// is replaced whole by the deterministic graph below, never executed in part.
//
// What a planner sees is the redacted planning context: the goal, the intent's
// flags, the authorized document ids and count, the catalog descriptors, the
// limits, and the remaining budget. Never document text, access scope, user or
// workspace identity, approvals, or credentials.

export const UNIFIED_GRAPH_PLANNER_IDS = Object.freeze({
  deterministic: "deterministic_unified_graph",
  llm: "llm_unified_graph",
});

const MAX_ID_LENGTH = 80;
const MAX_RATIONALE_LENGTH = 160;
const FAILURE_POLICY = EXECUTION_GRAPH_FAILURE_POLICIES.failFast;

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toArray = (value) => (Array.isArray(value) ? value : []);

const request = (field) => ({ field, source: EXECUTION_GRAPH_BINDING_SOURCES.request });
const upstream = (nodeId, output) => ({
  nodeId,
  output,
  source: EXECUTION_GRAPH_BINDING_SOURCES.node,
});

// ---------------------------------------------------------------------------
// Prompt

// The descriptor fields a planner needs to wire a graph, compacted: field name
// to type (with `?` for optional inputs). The response schema carries the
// exact contract; this is only the model's reading copy.
const compactCapability = (descriptor = {}) => ({
  id: descriptor.id,
  kind: descriptor.kind,
  stage: descriptor.stage ?? null,
  summary: normalizeText(descriptor.summary || descriptor.label).slice(0, 200),
  effects: descriptor.effects,
  inputs: Object.fromEntries(
    Object.entries(descriptor.inputSchema ?? {}).map(([field, spec]) => [
      field,
      `${spec?.type ?? "unknown"}${spec?.required ? "" : "?"}`,
    ])
  ),
  outputs: Object.fromEntries(
    Object.entries(descriptor.outputSchema ?? {}).map(([field, spec]) => [
      field,
      spec?.type ?? "unknown",
    ])
  ),
  ...(descriptor.approval ? { approval: descriptor.approval } : {}),
});

export const buildUnifiedGraphPlannerInput = (context = {}) => ({
  goal: normalizeText(context.goal),
  intentPlan: context.intentPlan ?? {},
  authorizedDocIds: toArray(context.authorizedDocIds),
  documentCount: context.documentCount ?? 0,
  capabilities: toArray(context.capabilities).map(compactCapability),
  limits: context.limits ?? {},
  budgetRemaining: context.budgetRemaining ?? {},
  taskMemoryPlanningContext: context.taskMemoryPlanningContext ?? null,
});

export const buildUnifiedGraphPlannerPrompt = (context = {}) =>
  [
    "You are planning one guarded AgentRAG execution graph (contract v3) that answers the whole request.",
    "Return only JSON. Do not include markdown, prose, or extra keys.",
    'The JSON shape is: {"nodes":[{"nodeId":"...","skillId":"...","dependsOn":["..."],"inputBindings":{"<input>":{"source":"request","field":"question"}},"failurePolicy":"fail_fast","when":null,"rationale":"..."}]}.',
    "Use only skillId values listed in capabilities. Never invent tools, ids, endpoints, or data access.",
    "A node's nodeId is its skillId; a second node with the same skillId is <skillId>_2.",
    'An input binding is {"source":"request","field":"docIds|question|retrievalPlan"} or {"source":"node","nodeId":"<an id in dependsOn>","output":"<an output that node\'s skill lists>"}. Never write free text or document content into an input.',
    'when is null or {"nodeId":"<an id in dependsOn>","output":"<a boolean output of that node\'s skill>","equals":true|false}; the node runs only when that output equals the value.',
    "Rules the runtime enforces (a graph that breaks one is discarded whole):",
    "- The graph contains a node for the Skill named by intentPlan.mode (or each Skill in intentPlan.skillChain), or for capability:<intentPlan.actionCapabilityId> when intentPlan.mode is workspace_action.",
    "- Every node named in a node's inputBindings or when is listed in that node's dependsOn.",
    "- If authorizedDocIds is non-empty, answer from the documents first: document_rag with docIds and question from the request, no dependsOn, and when null.",
    "- document_evidence_check binds evidence to that document_rag node's evidence output and depends on it. A second document_rag may run only with when retryRecommended == true on that check, question bound to the check's followUpQuestion.",
    "- web_search binds only question from the request, and its output never feeds another node. Unless intentPlan.wantsWeb is true, gate it with when passed == false on the primary document answer's check.",
    "- To give a custom Skill or a capability verified document facts, depend on the document_rag node and its check, set when passed == true on the check, and bind priorFindings (or a text input) to the document_rag node's text output.",
    "- A capability whose approval.required is true is paused by the runtime for the user's decision. Use at most one, and only when intentPlan.mode is workspace_action.",
    "- Do not emit approval, budget, accessScope, retry, concurrency, or policy fields. The runtime owns them.",
    "Task memory, when present, is planning context only, never evidence.",
    "Plan the fewest nodes that answer the request.",
    "Input:",
    JSON.stringify(buildUnifiedGraphPlannerInput(context)),
  ].join("\n");

// The planning context is appended as JSON at the end, so an empty context
// fingerprints the instructions alone.
let unifiedGraphPlannerPromptDescriptor = null;

export const getUnifiedGraphPlannerPromptDescriptor = () =>
  (unifiedGraphPlannerPromptDescriptor ??= definePrompt({
    id: PROMPT_IDS.unifiedGraphPlanner,
    source: buildUnifiedGraphPlannerPrompt({}),
    version: "v1",
  }));

// ---------------------------------------------------------------------------
// Response schema

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A node's id is its Skill id, or <skillId>_2.._9 for another node of the
// same Skill. Tying ids to Skills lets the schema name, for every binding and
// condition, only outputs the source node's own Skill declares.
const nodeIdOf = (skillId) => ({
  pattern: `^${escapeRegex(skillId)}(_[2-9])?$`,
  type: "string",
});

// An object input takes an output of the same name, or its `followUp`
// variant (a follow-up retrieval reads the check's followUpRetrievalPlan).
const matchesObjectInput = (field, output) =>
  output === field ||
  output === `followUp${field.charAt(0).toUpperCase()}${field.slice(1)}`;

// Narrower than the validator on purpose (the schema only narrows):
//   * a node output binds only to an input of exactly its type, and an
//     object input only to an output of its own name (see above);
//   * a node never binds an output of its own Skill (no admissible v3 graph
//     does: a follow-up document call reads its check, not the first call);
//   * a scoped docIds input binds only to the request's authorized ids (no
//     admissible v3 graph binds it from a node: discovery, the only Skill
//     with such an output, runs alone).
const buildBindingSchema = ({ capabilities, field, inputSpec, targetId }) => {
  const requestFields = Object.entries(EXECUTION_REQUEST_FIELD_TYPES)
    .filter(([requestField, type]) => type === inputSpec.type && (field !== "docIds" || requestField === "docIds"))
    .map(([requestField]) => requestField);
  const nodeSources = field === "docIds" && inputSpec.scoped === true
    ? []
    : capabilities.flatMap((source) => {
        if (source.id === targetId) {
          return [];
        }

        const outputs = Object.entries(source.outputSchema ?? {})
          .filter(([output, spec]) =>
            spec?.type === inputSpec.type &&
            (inputSpec.type !== SKILL_VALUE_TYPES.object || matchesObjectInput(field, output))
          )
          .map(([output]) => output);

        return outputs.length > 0
          ? [
              strictObject({
                source: stringEnum([EXECUTION_GRAPH_BINDING_SOURCES.node]),
                nodeId: nodeIdOf(source.id),
                output: stringEnum(outputs),
              }),
            ]
          : [];
      });
  const alternatives = [
    ...(requestFields.length > 0
      ? [
          strictObject({
            source: stringEnum([EXECUTION_GRAPH_BINDING_SOURCES.request]),
            field: stringEnum(requestFields),
          }),
        ]
      : []),
    ...nodeSources,
    ...(inputSpec.required ? [] : [{ type: "null" }]),
  ];

  return alternatives.length > 0 ? oneOfSchemas(alternatives) : null;
};

/**
 * One node variant per catalog entry the planner was shown: its id tied to
 * its Skill id, its own input names, each bound to a request field or to an
 * output of exactly the input's type that another node's Skill declares;
 * `when` only on a required boolean output of the named source Skill. That
 * dependsOn names real nodes and that a binding's source is a dependency stay
 * the validator's checks.
 */
export const buildUnifiedGraphPlannerResponseFormat = ({
  capabilities = [],
  limits = EXECUTION_GRAPH_LIMITS,
} = {}) => {
  if (capabilities.length === 0) {
    return null;
  }

  const conditions = capabilities.flatMap((source) => {
    const outputs = Object.entries(source.outputSchema ?? {})
      .filter(([, spec]) => spec?.type === SKILL_VALUE_TYPES.boolean && spec.required === true)
      .map(([output]) => output);

    return outputs.length > 0
      ? [
          strictObject({
            nodeId: nodeIdOf(source.id),
            output: stringEnum(outputs),
            equals: { type: "boolean" },
          }),
        ]
      : [];
  });
  const whenSchema = conditions.length > 0
    ? { anyOf: [...conditions, { type: "null" }] }
    : { type: "null" };
  const maxNodes = limits.maxNodes ?? EXECUTION_GRAPH_LIMITS.maxNodes;
  const nodeVariants = capabilities.map((capability) =>
    strictObject({
      nodeId: nodeIdOf(capability.id),
      skillId: stringEnum([capability.id]),
      dependsOn: boundedArray(identifierString(MAX_ID_LENGTH), maxNodes),
      inputBindings: strictObject(
        Object.fromEntries(
          Object.entries(capability.inputSchema ?? {})
            .map(([input, inputSpec]) => [
              input,
              buildBindingSchema({
                capabilities,
                field: input,
                inputSpec: inputSpec ?? {},
                targetId: capability.id,
              }),
            ])
            .filter(([, schema]) => schema)
        )
      ),
      failurePolicy: stringEnum(Object.values(EXECUTION_GRAPH_FAILURE_POLICIES)),
      when: whenSchema,
      rationale: nullable(boundedString(MAX_RATIONALE_LENGTH)),
    })
  );

  return buildJsonSchemaResponseFormat({
    name: "agent_unified_execution_graph",
    schema: strictObject({
      nodes: boundedArray(oneOfSchemas(nodeVariants), maxNodes),
    }),
  });
};

// A strict schema cannot leave a property out, so an unbound optional input or
// an unconditional node arrives as null. Null means "not given": removing it
// undoes the schema's encoding of absence, and every field the model did set
// reaches the validator untouched (forged fields included).
export const dropUnifiedGraphSchemaAbsentValues = (payload) => {
  if (!isRecord(payload) || !Array.isArray(payload.nodes)) {
    return payload;
  }

  return {
    ...payload,
    nodes: payload.nodes.map((node) => {
      if (!isRecord(node)) {
        return node;
      }

      const { inputBindings, scope, when, ...rest } = node;

      return {
        ...rest,
        ...(scope === null || scope === undefined ? {} : { scope }),
        ...(when === null || when === undefined ? {} : { when }),
        ...(isRecord(inputBindings)
          ? {
              inputBindings: Object.fromEntries(
                Object.entries(inputBindings).filter(([, binding]) => binding !== null)
              ),
            }
          : inputBindings === undefined
            ? {}
            : { inputBindings }),
      };
    }),
  };
};

// ---------------------------------------------------------------------------
// Deterministic graph

const findCapability = (capabilities, id) =>
  toArray(capabilities).find((capability) => capability?.id === id) ?? null;

const hasInput = (capability, field) => Boolean(capability?.inputSchema?.[field]);

const buildDocumentNode = (documentSkill, nodeId = "document") => ({
  dependsOn: [],
  failurePolicy: FAILURE_POLICY,
  inputBindings: {
    docIds: request("docIds"),
    question: request("question"),
    ...(hasInput(documentSkill, "retrievalPlan")
      ? { retrievalPlan: request("retrievalPlan") }
      : {}),
  },
  nodeId,
  skillId: AGENT_SKILL_IDS.documentRag,
});

const buildCheckNode = (documentNodeId, nodeId) => ({
  dependsOn: [documentNodeId],
  failurePolicy: FAILURE_POLICY,
  inputBindings: {
    docIds: request("docIds"),
    evidence: upstream(documentNodeId, "evidence"),
    question: request("question"),
  },
  nodeId,
  skillId: AGENT_SKILL_IDS.documentEvidenceCheck,
});

// Only string inputs that describe the action take the verified document
// answer; titles and everything else read the user's own request.
const DOCUMENT_TEXT_INPUTS = new Set(["description", "summary", "notes"]);

const buildDocumentGatedLoop = ({ capabilities }) => {
  const documentSkill = findCapability(capabilities, AGENT_SKILL_IDS.documentRag);
  const checkSkill = findCapability(capabilities, AGENT_SKILL_IDS.documentEvidenceCheck);

  return documentSkill && checkSkill
    ? [buildDocumentNode(documentSkill), buildCheckNode("document", "evidence_check")]
    : null;
};

const bindSkillInputs = ({ capability, previousNodeId = null, verifiedDocumentNodeId = null }) =>
  Object.fromEntries(
    Object.entries(capability.inputSchema ?? {}).flatMap(([field, spec]) => {
      if (field === "docIds" && spec?.type === SKILL_VALUE_TYPES.stringArray) {
        return [[field, request("docIds")]];
      }

      if (field === "retrievalPlan") {
        return [[field, request("retrievalPlan")]];
      }

      if (field === "priorFindings") {
        const source = previousNodeId ?? verifiedDocumentNodeId;
        return source ? [[field, upstream(source, "text")]] : [];
      }

      if (spec?.type !== SKILL_VALUE_TYPES.string) {
        return [];
      }

      if (DOCUMENT_TEXT_INPUTS.has(field) && verifiedDocumentNodeId) {
        return [[field, upstream(verifiedDocumentNodeId, "text")]];
      }

      return field === "question" || field === "title" || spec.required
        ? [[field, request("question")]]
        : [];
    })
  );

/**
 * The deterministic v3 graph for an intent, from the authorized catalog alone:
 *   * document intents: the V1 document loop as nodes (primary answer, its
 *     evidence check, a follow-up only when the check recommends one, and its
 *     check), plus a Web node gated on a failed primary check when the intent
 *     asked for the Web;
 *   * a Skill or Skill chain with selected documents: the document answer and
 *     its check first, the Skills only when that answer passed, the first one
 *     reading the verified answer as priorFindings (without documents, the V1
 *     chain);
 *   * a workspace action: the same verified-document gate before the
 *     approval-gated Capability, whose descriptive text input reads the
 *     verified answer (without documents, the action alone);
 *   * inventory, discovery, or Web alone: that single node.
 * Anything else has no deterministic v3 shape and is refused (V1 answers).
 */
export const createDeterministicUnifiedExecutionGraph = (context = {}) => {
  const capabilities = toArray(context.capabilities);
  const intent = context.intentPlan ?? {};
  const mode = normalizeText(intent.mode);
  const hasDocuments = toArray(context.authorizedDocIds).length > 0;
  const single = (skillId, inputBindings) => {
    if (!findCapability(capabilities, skillId)) {
      throw new Error(`The authorized catalog has no ${skillId} for intent ${mode}.`);
    }

    return [{ dependsOn: [], failurePolicy: FAILURE_POLICY, inputBindings, nodeId: skillId, skillId }];
  };
  let nodes;

  if (mode === "inventory") {
    nodes = single(AGENT_SKILL_IDS.inventory, {});
  } else if (mode === "document_discovery") {
    nodes = single(AGENT_SKILL_IDS.documentDiscovery, {
      docIds: request("docIds"),
      question: request("question"),
    });
  } else if (mode === "web" && !hasDocuments) {
    nodes = single(AGENT_SKILL_IDS.webSearch, { question: request("question") });
  } else if (mode === "workspace_action") {
    const action = findCapability(capabilities, `capability:${normalizeText(intent.actionCapabilityId)}`);

    if (!action) {
      throw new Error("The authorized catalog has no Capability for this workspace action.");
    }

    const loop = hasDocuments ? buildDocumentGatedLoop({ capabilities }) : null;
    nodes = [
      ...(loop ?? []),
      {
        dependsOn: loop ? ["document", "evidence_check"] : [],
        failurePolicy: FAILURE_POLICY,
        inputBindings: bindSkillInputs({
          capability: action,
          verifiedDocumentNodeId: loop ? "document" : null,
        }),
        nodeId: "action",
        skillId: action.id,
        ...(loop ? { when: { equals: true, nodeId: "evidence_check", output: "passed" } } : {}),
      },
    ];
  } else if (["document", "document_web"].includes(mode) && hasDocuments) {
    const loop = buildDocumentGatedLoop({ capabilities });

    if (!loop) {
      throw new Error("The authorized catalog has no document loop for this request.");
    }

    const checkOutputs = findCapability(capabilities, AGENT_SKILL_IDS.documentEvidenceCheck)
      ?.outputSchema ?? {};
    const documentSkill = findCapability(capabilities, AGENT_SKILL_IDS.documentRag);
    nodes = [
      ...loop,
      {
        dependsOn: ["evidence_check"],
        failurePolicy: FAILURE_POLICY,
        inputBindings: {
          docIds: request("docIds"),
          question: upstream("evidence_check", "followUpQuestion"),
          ...(checkOutputs.followUpRetrievalPlan && hasInput(documentSkill, "retrievalPlan")
            ? { retrievalPlan: upstream("evidence_check", "followUpRetrievalPlan") }
            : {}),
        },
        nodeId: "follow_up",
        skillId: AGENT_SKILL_IDS.documentRag,
        when: { equals: true, nodeId: "evidence_check", output: "retryRecommended" },
      },
      buildCheckNode("follow_up", "follow_up_check"),
      ...(intent.wantsWeb === true && findCapability(capabilities, AGENT_SKILL_IDS.webSearch)
        ? [{
            dependsOn: ["evidence_check"],
            failurePolicy: FAILURE_POLICY,
            inputBindings: { question: request("question") },
            nodeId: "web",
            skillId: AGENT_SKILL_IDS.webSearch,
            when: { equals: false, nodeId: "evidence_check", output: "passed" },
          }]
        : []),
    ];
  } else {
    const chain = toArray(intent.skillChain).length > 0 ? intent.skillChain : [mode];
    const skills = chain.map((skillId) => findCapability(capabilities, normalizeText(skillId)));

    if (skills.length === 0 || skills.some((skill) => skill?.kind !== "custom")) {
      throw new Error(`No deterministic v3 graph represents intent ${mode || "(none)"}.`);
    }

    const loop = hasDocuments ? buildDocumentGatedLoop({ capabilities }) : null;
    nodes = [...(loop ?? [])];
    let previousNodeId = null;

    for (const skill of skills) {
      const nodeId = nodes.some((node) => node.nodeId === skill.id)
        ? `${skill.id}_${nodes.length}`
        : skill.id;
      const gated = loop && !previousNodeId;

      nodes.push({
        dependsOn: previousNodeId
          ? [previousNodeId]
          : gated
            ? ["document", "evidence_check"]
            : [],
        failurePolicy: FAILURE_POLICY,
        inputBindings: bindSkillInputs({
          capability: skill,
          previousNodeId,
          verifiedDocumentNodeId: gated ? "document" : null,
        }),
        nodeId,
        skillId: skill.id,
        ...(gated ? { when: { equals: true, nodeId: "evidence_check", output: "passed" } } : {}),
      });
      previousNodeId = nodeId;
    }
  }

  return { nodes, revision: 0, version: EXECUTION_GRAPH_VERSIONS.v3 };
};

export const deterministicUnifiedGraphPlannerAdapter = Object.freeze({
  createExecutionGraph: (context = {}) => createDeterministicUnifiedExecutionGraph(context),
  id: UNIFIED_GRAPH_PLANNER_IDS.deterministic,
});

// ---------------------------------------------------------------------------
// Model adapter

const readPlannerTokens = (runUsage) =>
  getRunPromptUsage(runUsage)
    .filter((entry) => entry.id === PROMPT_IDS.unifiedGraphPlanner)
    .reduce((sum, entry) => sum + (Number.isFinite(entry.tokens) ? entry.tokens : 0), 0);

// Non-enumerable, so the payload still validates and serializes as the plain
// graph the model returned.
const attachPlanMetadata = (payload, metadata) => {
  if (!isRecord(payload)) {
    return payload;
  }

  Object.defineProperty(payload, "plannerCall", {
    configurable: true,
    enumerable: false,
    value: metadata,
  });

  return payload;
};

const digestResponseFormat = (responseFormat) =>
  responseFormat
    ? `sha256:${createHash("sha256").update(JSON.stringify(responseFormat)).digest("hex").slice(0, 16)}`
    : null;

export const unifiedGraphLlmPlannerAdapter = Object.freeze({
  createExecutionGraph: async (context = {}) => {
    const promptTemplate = getUnifiedGraphPlannerPromptDescriptor();
    const runUsage = getActiveRunUsage();
    const tokensBefore = readPlannerTokens(runUsage);
    const responseFormat = buildUnifiedGraphPlannerResponseFormat(context);
    const startedAt = Date.now();
    const completion = await completeTextWithMetadata(
      buildUnifiedGraphPlannerPrompt(context),
      {
        capability: MODEL_CAPABILITIES.executionPlanner,
        promptTemplate,
        responseFormat,
        routeId: MODEL_ROUTE_IDS.executionPlannerDefault,
      }
    );
    const metadata = {
      latencyMs: Math.max(0, Date.now() - startedAt),
      modelRoute: completion.modelRoute ?? null,
      promptTemplate,
      // Which constrained-decoding schema this call ran under (it is built per
      // request from the authorized catalog), so a report can tie its numbers
      // to one schema shape. A digest only; the schema holds no request text.
      responseFormatDigest: digestResponseFormat(responseFormat),
      tokens: runUsage ? readPlannerTokens(runUsage) - tokensBefore : null,
    };

    try {
      return attachPlanMetadata(
        dropUnifiedGraphSchemaAbsentValues(parsePlannerJson(completion.text)),
        metadata
      );
    } catch (error) {
      error.plannerCall = metadata;
      throw error;
    }
  },
  // A proposal that fails validation or admission is replaced whole by the
  // deterministic graph; it is never executed in part.
  fallbackPlannerAdapter: deterministicUnifiedGraphPlannerAdapter,
  id: UNIFIED_GRAPH_PLANNER_IDS.llm,
});
