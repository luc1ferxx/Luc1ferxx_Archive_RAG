import { ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { listAuthorizedAtomicCustomSkills } from "../skills/authorized-catalog.js";
import { executeAgentSkill } from "../skills/registry.js";
import {
  SKILL_VALUE_TYPES,
  describeSkillForPlanner,
  getSkillContract,
  validateSkillValues,
} from "../skills/skill-contract.js";
import { assertLangSmithTracingDisabled, guardRunnableEntryPoints } from "./langsmith-guard.js";

// Skills as LangChain tools (docs/adr/0001-langgraph-runtime.md, phase 1).
//
// Only Skills listAuthorizedAtomicCustomSkills returns for the request become
// tools: the model may only propose inside the whitelist the runtime already
// authorized (constraint 1), the same pool the DAG planner sees. A tool runs
// its Skill through executeAgentSkill with the same input and output contract
// gates a graph node gives it (executeExecutionGraphNodeLaunch in
// agent-execution-graph-node.js), and with the context this adapter builds:
// the runtime fields below plus memoryWrites false. What that proves, and all
// it proves, is that the tool's result is executeAgentSkill's for that
// context (test/langgraph-tools-adapter.test.mjs). It is not a graph node's
// own call: a node launch goes through executeObservedSkill with a reserved
// budget, adds graphOutput checks, and sets memoryWrites false only when the
// node's question is bound to an upstream output.
//
// What the tool does not do: reserve budget, open a lifecycle step, record
// Skill observations or a span. In a graph run the node launch
// (agent-execution-graph-node.js) and executeObservedSkill do that around
// executeAgentSkill; the caller that hands these tools to a graph or agent
// keeps that responsibility (constraint 11).
//
// The model fills only the fields in MODEL_WRITABLE_SKILL_FIELDS (question,
// priorFindings), an allowlist: a field a Skill contract adds later is not
// offered to the model until it is added here with a test, because a graph
// node's inputs never take a model-written literal either (they bind to
// request fields or upstream outputs, skill-contract.js). The runtime owns
// everything that decides what a call may read or who it acts for: access
// scope, the authorized document ids, identity, services, and the retrieval
// plan (its topK is a retrieval limit, which the runtime sets, never the
// model). Those are read once, when the tool is built, so the values the
// catalog authorized are the values every call runs with. A tool call that
// tries to set any other contract field, or a runtime-owned one, is refused
// rather than quietly overridden, so a model or an injected document cannot
// believe it narrowed or widened the scope; the call itself still takes those
// values from the runtime only.

export const RUNTIME_OWNED_SKILL_FIELDS = Object.freeze([
  "accessScope",
  "approval",
  "approvals",
  "budget",
  "budgetState",
  "capabilityRegistry",
  "docIds",
  "memoryWrites",
  "ragService",
  "registry",
  "retrievalPlan",
  "services",
  "sessionId",
  "userId",
]);

// The only Skill inputs a model may write. Adding one is a decision about
// what the model controls; it needs its own test.
export const MODEL_WRITABLE_SKILL_FIELDS = Object.freeze(["priorFindings", "question"]);

export const SKILL_TOOL_ERROR_CODES = Object.freeze({
  inputInvalid: "SKILL_TOOL_INPUT_INVALID",
  notAuthorized: "SKILL_TOOL_NOT_AUTHORIZED",
  runtimeField: "SKILL_TOOL_RUNTIME_FIELD",
  skillFailed: "SKILL_TOOL_SKILL_FAILED",
});

const RUNTIME_OWNED = new Set(RUNTIME_OWNED_SKILL_FIELDS);
const MODEL_WRITABLE = new Set(MODEL_WRITABLE_SKILL_FIELDS);
// A code is passed on only when it looks like one (FOO_BAR); anything else
// could be text.
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

// What the model reads in the tool's JSON Schema. Only the planner-visible
// Skill summary (describeSkillForPlanner) describes the tool itself.
const FIELD_DESCRIPTIONS = Object.freeze({
  priorFindings:
    "Optional findings from an earlier step, used as context only and never as evidence.",
  question: "What this Skill should answer from the selected documents.",
});

// Error messages carry codes, field names and Skill ids only: never the
// question, findings or any other argument value.
const createSkillToolError = (code, message, details = {}) => {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
};

const toZodType = (type) => {
  switch (type) {
    case SKILL_VALUE_TYPES.boolean:
      return z.boolean();
    case SKILL_VALUE_TYPES.citationArray:
      return z.array(z.record(z.string(), z.unknown()));
    case SKILL_VALUE_TYPES.number:
      return z.number();
    case SKILL_VALUE_TYPES.string:
      return z.string();
    case SKILL_VALUE_TYPES.stringArray:
      return z.array(z.string());
    default:
      return z.record(z.string(), z.unknown());
  }
};

// A scoped field is an authorization boundary (getSkillContract marks the
// document ids so), so it is runtime-owned whatever its name.
const isRuntimeOwnedField = (fieldName, spec) => RUNTIME_OWNED.has(fieldName) || spec.scoped;

const isModelField = (fieldName, spec) =>
  MODEL_WRITABLE.has(fieldName) && !isRuntimeOwnedField(fieldName, spec);

const listModelFields = (contract) =>
  Object.entries(contract.inputSchema).filter(([fieldName, spec]) => isModelField(fieldName, spec));

// The zod schema only shapes what the model is offered and rejects malformed
// calls early; validateSkillValues against the Skill contract stays the
// authority, exactly as in the scheduler.
const buildModelSchema = (contract) =>
  z.object(
    Object.fromEntries(
      listModelFields(contract).map(([fieldName, spec]) => {
        const described = FIELD_DESCRIPTIONS[fieldName]
          ? toZodType(spec.type).describe(FIELD_DESCRIPTIONS[fieldName])
          : toZodType(spec.type);

        return [fieldName, spec.required ? described : described.optional()];
      })
    )
  );

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readToolArgs = (input) => (input?.type === "tool_call" ? input.args : input);

const refuseRuntimeOwnedFields = (args, contract) => {
  if (!isRecord(args)) {
    return;
  }

  // Runtime-owned names, and every contract field the model may not write.
  const fields = Object.keys(args)
    .filter((fieldName) =>
      isRuntimeOwnedField(fieldName, contract.inputSchema[fieldName] ?? {}) ||
      (Object.hasOwn(contract.inputSchema, fieldName) &&
        !isModelField(fieldName, contract.inputSchema[fieldName]))
    )
    .sort();

  if (fields.length > 0) {
    throw createSkillToolError(
      SKILL_TOOL_ERROR_CODES.runtimeField,
      `Skill tool ${contract.id} arguments may not set runtime-owned fields: ${fields.join(", ")}.`,
      { fields }
    );
  }
};

// LangChain's own parse failure (ToolInputParsingException) carries the whole
// argument object as JSON in `output`, the question included. Parsing first
// here means a malformed call fails with paths and issue codes only.
const refuseInvalidInput = (args, schema, contract) => {
  const parsed = schema.safeParse(args);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join("."),
    }));

    throw createSkillToolError(
      SKILL_TOOL_ERROR_CODES.inputInvalid,
      `Skill tool ${contract.id} input does not match its schema: ${issues
        .map(({ code, path }) => `${path || "(input)"} ${code}`)
        .join(", ")}.`,
      { issues }
    );
  }
};

// A LangChain config is a plain object; a callbacks array or a callback
// manager/handler (anything with a name) stands in for one on the legacy
// call() path and has no signal to drop.
const withoutAbortSignal = (config) => {
  if (!isRecord(config) || "name" in config) {
    return config;
  }

  const { signal: _signal, timeout: _timeout, ...rest } = config;

  return rest;
};

// Every runtime field, read once. The catalog authorizes these values and
// every call of the tools built from them runs with them, so a runtime object
// changed or reused afterwards cannot move an authorized tool to another
// scope, document set or service. Objects are kept as given (the Skill gets
// the run's own accessScope object, as the scheduler passes it); the id list
// is copied, so a later change to the caller's array changes nothing.
const snapshotRuntime = (runtime) =>
  Object.freeze({
    accessScope: runtime?.accessScope,
    capabilityRegistry: runtime?.capabilityRegistry,
    docIds: Array.isArray(runtime?.docIds) ? Object.freeze([...runtime.docIds]) : runtime?.docIds,
    ragService: runtime?.ragService,
    registry: runtime?.registry,
    retrievalPlan: runtime?.retrievalPlan,
    services: runtime?.services,
    sessionId: runtime?.sessionId,
    userId: runtime?.userId,
  });

const readCatalogInput = (runtime) => ({
  accessScope: runtime.accessScope,
  docIds: runtime.docIds,
  ragService: runtime.ragService,
  registry: runtime.registry,
});

const describeSkillFailureCode = (result) => {
  const code = result?.error?.code;

  return typeof code === "string" && SAFE_ERROR_CODE_PATTERN.test(code)
    ? code
    : SKILL_TOOL_ERROR_CODES.skillFailed;
};

// `runtime` is a snapshotRuntime value.
const buildSkillTool = (skill, runtime) => {
  const contract = getSkillContract(skill);
  const schema = buildModelSchema(contract);
  const modelFieldNames = listModelFields(contract).map(([fieldName]) => fieldName);
  const authorizedDocIds = runtime.docIds;

  // tool() calls this with the parsed arguments and the run config, whose
  // toolCall is set when the call came in as a ToolCall.
  const runSkill = async (args, config) => {
    assertLangSmithTracingDisabled();

    // Only the Skill's own model-facing fields are taken from the call; the
    // runtime fields below are spread last, so nothing the model sends can
    // replace them even if the argument checks were bypassed.
    const modelInputs = Object.fromEntries(
      modelFieldNames
        .filter((fieldName) => isRecord(args) && Object.hasOwn(args, fieldName))
        .map((fieldName) => [fieldName, args[fieldName]])
        .filter(([, value]) => value !== undefined)
    );
    // Each call gets its own copy, as each scheduler node gets its own array.
    const docIds = [...authorizedDocIds];
    // The scheduler validates the bound inputs: the model's fields, the
    // authorized document ids, and the request's retrieval plan when it has one.
    const boundInputs = {
      ...modelInputs,
      ...(contract.inputSchema.docIds ? { docIds } : {}),
      ...(contract.inputSchema.retrievalPlan && runtime.retrievalPlan != null
        ? { retrievalPlan: runtime.retrievalPlan }
        : {}),
    };
    const inputValidation = validateSkillValues({
      allowNestedValue: false,
      output: boundInputs,
      schema: contract.inputSchema,
    });
    const result = await executeAgentSkill(
      skill,
      {
        ...modelInputs,
        accessScope: runtime.accessScope,
        capabilityRegistry: runtime.capabilityRegistry,
        docIds,
        // The model wrote this question, so it is agent text, never the
        // user's message: like a scheduler node whose question is bound to an
        // upstream output, it must not write conversation memory.
        memoryWrites: false,
        priorFindings: modelInputs.priorFindings,
        question: modelInputs.question,
        ragService: runtime.ragService,
        retrievalPlan: runtime.retrievalPlan,
        services: runtime.services,
        sessionId: runtime.sessionId,
        userId: runtime.userId,
      },
      {
        validateInput: () => inputValidation,
        validateOutput: (output) =>
          validateSkillValues({ output, schema: contract.outputSchema }),
      }
    );

    // A failed Skill must not reach the model as an empty answer. A model's
    // call (a ToolCall) gets an error ToolMessage: status "error", content
    // the error code alone -- never the error's message, which may quote a
    // question or evidence -- and the whole failed result as the artifact,
    // as a success has it. Plain arguments have no message to mark, so the
    // failure is thrown with the same code.
    if (result?.ok === false) {
      const code = describeSkillFailureCode(result);
      const toolCallId = config?.toolCall?.id;

      if (typeof toolCallId === "string" && toolCallId !== "") {
        return [
          new ToolMessage({
            artifact: result,
            content: code,
            name: contract.id,
            status: "error",
            tool_call_id: toolCallId,
          }),
          result,
        ];
      }

      throw createSkillToolError(
        SKILL_TOOL_ERROR_CODES.skillFailed,
        `Skill tool ${contract.id} failed (${code}).`,
        { skillErrorCode: code }
      );
    }

    return [result.text, result];
  };

  const skillTool = tool(runSkill, {
    description: describeSkillForPlanner(skill).summary || contract.label,
    name: contract.id,
    responseFormat: "content_and_artifact",
    schema,
  });

  // StructuredTool.invoke merges configs and then calls this.call, which
  // builds the callback manager (where a LangSmith tracer would attach),
  // parses the arguments and runs runSkill. Both are wrapped on the instance:
  // invoke so the LangSmith check comes before any LangChain code runs, call
  // because it is also callable directly.
  //
  // A tool makes no AsyncCaller of its own, so there are no LangChain retries
  // or queue to neutralise here. The abort signal is the remaining hazard:
  // tool() rejects the moment config.signal aborts (LangGraph aborts it when a
  // sibling task fails) while the Skill keeps running, and its result is
  // lost. The signal is therefore dropped: a tool call settles only when its
  // Skill has, and cancellation comes from the request deadline that
  // executeAgentSkill and every model and retrieval call already observe
  // (request-deadline.js), as the ADR's drain decision requires.
  const langChainInvoke = skillTool.invoke.bind(skillTool);
  const langChainCall = skillTool.call.bind(skillTool);

  skillTool.invoke = async (input, config) => {
    assertLangSmithTracingDisabled();

    return langChainInvoke(input, config);
  };

  skillTool.call = async (input, config, tags) => {
    assertLangSmithTracingDisabled();

    const args = readToolArgs(input);

    refuseRuntimeOwnedFields(args, contract);
    refuseInvalidInput(args, schema, contract);

    return langChainCall(input, withoutAbortSignal(config), tags);
  };

  // stream, batch and the runnables pipe / withConfig / ... build check
  // LangSmith first too.
  return guardRunnableEntryPoints(skillTool);
};

/**
 * One LangChain tool for `skill`, bound to this request's `runtime`:
 * { accessScope, docIds, ragService, registry } (what the authorized catalog
 * checks) plus { capabilityRegistry, retrievalPlan, services, sessionId,
 * userId } (passed to the Skill as the scheduler passes them), all read once,
 * here. Throws SKILL_TOOL_NOT_AUTHORIZED unless the authorized catalog
 * returns this exact Skill object for that runtime. Build tools per request;
 * never share them across requests or scopes. Invoke it with a ToolCall:
 * LangChain returns the artifact (the full Skill result) only inside a
 * ToolMessage, whose status is "error" when the Skill failed; plain arguments
 * get the answer text alone, and a failed Skill throws SKILL_TOOL_SKILL_FAILED.
 */
export const createSkillTool = ({ skill, runtime } = {}) => {
  assertLangSmithTracingDisabled();

  const boundRuntime = snapshotRuntime(runtime);

  if (!listAuthorizedAtomicCustomSkills(readCatalogInput(boundRuntime)).includes(skill)) {
    throw createSkillToolError(
      SKILL_TOOL_ERROR_CODES.notAuthorized,
      `Skill ${String(skill?.id ?? "unknown")} is not in the authorized catalog for this request.`
    );
  }

  return buildSkillTool(skill, boundRuntime);
};

/**
 * A tool for every Skill the authorized catalog returns for `runtime` (see
 * createSkillTool), in registry order; none when the catalog grants nothing
 * (an empty or unverifiable document set, no access scope).
 */
export const createAuthorizedSkillTools = ({ runtime } = {}) => {
  assertLangSmithTracingDisabled();

  const boundRuntime = snapshotRuntime(runtime);

  return listAuthorizedAtomicCustomSkills(readCatalogInput(boundRuntime)).map((skill) =>
    buildSkillTool(skill, boundRuntime)
  );
};
