// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import assert from "node:assert/strict";
import test from "node:test";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { DynamicStructuredTool, tool } from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { z } from "zod";
import {
  buildScopedRagService,
  createEvalTelemetry,
} from "../evaluation/agent-eval-harness.js";
import {
  DEFAULT_ACCESS_SCOPE,
  sameTrajectoryScope,
} from "../evaluation/trajectory/checks.js";
import {
  LANGSMITH_TRACING_ENABLED_CODE,
  LANGSMITH_TRACING_VARIABLES,
} from "../rag/langgraph/langsmith-guard.js";
import {
  MODEL_WRITABLE_SKILL_FIELDS,
  RUNTIME_OWNED_SKILL_FIELDS,
  SKILL_TOOL_ERROR_CODES,
  createAuthorizedSkillTools,
  createSkillTool,
} from "../rag/langgraph/tools.js";
import { getActiveDatabaseTenant, runWithDatabaseTenant } from "../rag/postgres-tenant.js";
import { isRequestCancelledError, runWithRequestDeadline } from "../rag/request-deadline.js";
import { listAuthorizedAtomicCustomSkills } from "../rag/skills/authorized-catalog.js";
import {
  AGENT_SKILL_IDS,
  CUSTOM_SKILL_IDS,
  createDefaultSkillRegistry,
  createDefaultSkills,
  createSkillRegistry,
  executeAgentSkill,
} from "../rag/skills/registry.js";
import {
  describeSkillForPlanner,
  getSkillContract,
  validateSkillValues,
} from "../rag/skills/skill-contract.js";

// Equivalence bar for rag/langgraph/tools.js: a Skill run through its LangChain
// tool returns exactly what executeAgentSkill returns for the same context and
// contract gates, and the Skill sends exactly the same ragService.chat call.
// The reference (runNatively) is executeAgentSkill called directly; it is not
// the graph scheduler, which goes through executeObservedSkill with a budget
// and sets memoryWrites false only for a question bound to an upstream output
// (agent-execution-graph-runner.js launchNode).

const ACCESS_SCOPE = Object.freeze({ ...DEFAULT_ACCESS_SCOPE });
const OTHER_SCOPE = Object.freeze({ userId: "other-user", workspaceId: "other-workspace" });
const DOCUMENTS = Object.freeze([
  Object.freeze({ docId: "vendor-msa", fileName: "vendor-msa.pdf" }),
  Object.freeze({ docId: "vendor-sow", fileName: "vendor-sow.pdf" }),
  Object.freeze({ docId: "unselected-handbook", fileName: "handbook.pdf" }),
]);
const DOC_IDS = Object.freeze(["vendor-msa", "vendor-sow"]);
const SESSION_ID = "langgraph-tools-session";
const QUESTION = "What notice period does the vendor require before renewal?";
const PRIOR_FINDINGS = "The MSA renews automatically every 12 months.";
const RETRIEVAL_PLAN = Object.freeze({
  intent: "risk_review",
  phase: "primary",
  retrievalOptions: Object.freeze({ profile: "default", topK: 6 }),
  retrievalQueries: Object.freeze([
    Object.freeze({ id: "q1", label: "Notice", primary: true, query: "vendor renewal notice" }),
  ]),
  source: "agent-query-planner",
});
const SERVICES = Object.freeze({ marker: "runtime-services" });
const CAPABILITY_REGISTRY = Object.freeze({ marker: "runtime-capability-registry" });

const respondWithEvidence = ({ question }) => ({
  abstained: false,
  citations: [
    {
      docId: "vendor-msa",
      excerpt: "The vendor requires 30 days written notice before renewal.",
      fileName: "vendor-msa.pdf",
      pageNumber: 2,
    },
  ],
  // The composed Skill prompt's first line, so a prompt difference would also
  // show up in the answer the tool returns.
  text: `${question.split("\n")[0]} [Source 1]`,
});

const createRecordingRagService = ({ respond = respondWithEvidence } = {}) => {
  const telemetry = createEvalTelemetry();
  const chatArguments = [];
  const ragService = buildScopedRagService({
    chat: async ({ docIds, options, question }) => {
      chatArguments.push({ docIds, options, question, tenant: getActiveDatabaseTenant() });
      return respond({ docIds, options, question });
    },
    documents: DOCUMENTS,
    sameScope: sameTrajectoryScope,
    telemetry,
  });

  return { chatArguments, ragService, telemetry };
};

const createRuntime = ({ ragService, registry = createDefaultSkillRegistry(), ...overrides }) => ({
  accessScope: ACCESS_SCOPE,
  capabilityRegistry: CAPABILITY_REGISTRY,
  docIds: [...DOC_IDS],
  ragService,
  registry,
  retrievalPlan: RETRIEVAL_PLAN,
  services: SERVICES,
  sessionId: SESSION_ID,
  userId: ACCESS_SCOPE.userId,
  ...overrides,
});

// executeAgentSkill with the context and gates the adapter is meant to build,
// written out by hand rather than through the adapter: launchNode's bound-
// input validation (question/priorFindings as given, docIds and retrievalPlan
// from the request) and memoryWrites false, which launchNode itself sets only
// for a question bound to an upstream output.
const runNatively = (skill, { args, ragService }) => {
  const contract = getSkillContract(skill);
  const resolvedInputs = { ...args, docIds: [...DOC_IDS], retrievalPlan: RETRIEVAL_PLAN };
  const inputValidation = validateSkillValues({
    allowNestedValue: false,
    output: resolvedInputs,
    schema: contract.inputSchema,
  });

  return executeAgentSkill(
    skill,
    {
      ...resolvedInputs,
      accessScope: ACCESS_SCOPE,
      capabilityRegistry: CAPABILITY_REGISTRY,
      docIds: [...DOC_IDS],
      memoryWrites: false,
      priorFindings: args.priorFindings,
      question: args.question,
      ragService,
      retrievalPlan: RETRIEVAL_PLAN,
      services: SERVICES,
      sessionId: SESSION_ID,
      userId: ACCESS_SCOPE.userId,
    },
    {
      validateInput: () => inputValidation,
      validateOutput: (output) => validateSkillValues({ output, schema: contract.outputSchema }),
    }
  );
};

const toolCall = (name, args, id = "call-1") => ({ args, id, name, type: "tool_call" });

const authorizedSkills = (registry = createDefaultSkillRegistry()) =>
  listAuthorizedAtomicCustomSkills({
    accessScope: ACCESS_SCOPE,
    docIds: [...DOC_IDS],
    ragService: createRecordingRagService().ragService,
    registry,
  });

const createToolFor = (skillId, { respond } = {}) => {
  const recording = createRecordingRagService({ respond });
  const tools = createAuthorizedSkillTools({ runtime: createRuntime({ ragService: recording.ragService }) });
  const skillTool = tools.find((candidate) => candidate.name === skillId);

  assert.ok(skillTool, `${skillId} has a tool`);

  return { ...recording, skillTool };
};

const createDeferred = () => {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

const withEnvironmentVariable = async (name, value, callback) => {
  const hadValue = Object.hasOwn(process.env, name);
  const previous = process.env[name];

  process.env[name] = value;

  try {
    return await callback();
  } finally {
    if (hadValue) {
      process.env[name] = previous;
    } else {
      delete process.env[name];
    }
  }
};

test("only the Skills the authorized catalog returns become tools, in registry order", () => {
  const { ragService } = createRecordingRagService();
  const registry = createDefaultSkillRegistry();
  const tools = createAuthorizedSkillTools({ runtime: createRuntime({ ragService, registry }) });
  const catalog = listAuthorizedAtomicCustomSkills({
    accessScope: ACCESS_SCOPE,
    docIds: [...DOC_IDS],
    ragService,
    registry,
  });

  assert.deepEqual(tools.map((skillTool) => skillTool.name), catalog.map((skill) => skill.id));
  assert.deepEqual(
    [...tools.map((skillTool) => skillTool.name)].sort(),
    Object.values(CUSTOM_SKILL_IDS).sort()
  );

  for (const skillTool of tools) {
    const skill = registry.get(skillTool.name);

    // The model sees the planner's redacted summary, nothing else of the Skill.
    assert.equal(skillTool.description, describeSkillForPlanner(skill).summary);
    assert.equal(skillTool.responseFormat, "content_and_artifact");
  }
});

test("the model-facing schema is the Skill input contract without runtime-owned fields", () => {
  const { ragService } = createRecordingRagService();

  for (const skillTool of createAuthorizedSkillTools({ runtime: createRuntime({ ragService }) })) {
    const jsonSchema = toJsonSchema(skillTool.schema);
    const inputSchema = getSkillContract(createDefaultSkillRegistry().get(skillTool.name)).inputSchema;

    assert.deepEqual(Object.keys(jsonSchema.properties).sort(), ["priorFindings", "question"]);
    assert.deepEqual(jsonSchema.required, ["question"]);
    assert.equal(jsonSchema.properties.question.type, "string");
    assert.equal(jsonSchema.properties.priorFindings.type, "string");

    // Every contract field of the shipped Skills the model does not see is
    // runtime-owned or scoped (a field outside both is refused too, by the
    // allowlist; see the widened-contract test).
    for (const [fieldName, spec] of Object.entries(inputSchema)) {
      if (!Object.hasOwn(jsonSchema.properties, fieldName)) {
        assert.ok(
          RUNTIME_OWNED_SKILL_FIELDS.includes(fieldName) || spec.scoped,
          `${fieldName} is hidden only because the runtime owns it`
        );
      }
    }

    for (const fieldName of RUNTIME_OWNED_SKILL_FIELDS) {
      assert.equal(Object.hasOwn(jsonSchema.properties, fieldName), false, fieldName);
    }
  }
});

for (const skill of authorizedSkills()) {
  for (const [variant, args] of [
    ["question only", { question: QUESTION }],
    ["question and prior findings", { priorFindings: PRIOR_FINDINGS, question: QUESTION }],
  ]) {
    test(`${skill.id} (${variant}): tool artifact and ragService.chat call equal executeAgentSkill's`, async () => {
      const native = createRecordingRagService();
      const expected = await runNatively(skill, { args, ragService: native.ragService });
      const { chatArguments, skillTool, telemetry } = createToolFor(skill.id);
      const message = await skillTool.invoke(toolCall(skill.id, args));

      assert.equal(expected.ok, true);
      assert.deepStrictEqual(message.artifact, expected);
      assert.equal(message.content, expected.text);
      assert.equal(message.tool_call_id, "call-1");
      assert.equal(message.name, skill.id);
      assert.deepStrictEqual(chatArguments, native.chatArguments);
      assert.deepStrictEqual(telemetry, native.telemetry);
      assert.equal(chatArguments.length, 1);
      assert.deepStrictEqual(chatArguments[0].docIds, [...DOC_IDS]);
      assert.equal(chatArguments[0].options.accessScope, ACCESS_SCOPE);
      assert.equal(chatArguments[0].options.retrievalPlan, RETRIEVAL_PLAN);
      assert.equal(chatArguments[0].options.memoryWrites, false);
    });
  }
}

test("a failed Skill comes back as an error ToolMessage carrying the same failed result", async () => {
  const skill = createDefaultSkillRegistry().get(CUSTOM_SKILL_IDS.riskReview);
  const secret = "CONFIDENTIAL renewal clause quoted by an upstream error";
  const coded = (code) => Object.assign(new Error(`upstream unavailable: ${secret}`), { code });
  const failingResponses = [
    // ragService throws: executeAgentSkill turns it into a failed result.
    ["ragService error", () => {
      throw new Error(`upstream unavailable: ${secret}`);
    }, SKILL_TOOL_ERROR_CODES.skillFailed],
    // An error code is passed on when it looks like one, and only then.
    ["coded error", () => {
      throw coded("MODEL_GATEWAY_UNAVAILABLE");
    }, "MODEL_GATEWAY_UNAVAILABLE"],
    ["text in the code field", () => {
      throw coded(secret);
    }, SKILL_TOOL_ERROR_CODES.skillFailed],
    // The Skill returns a non-string answer: the output contract gate fails.
    ["output contract", () => ({ abstained: false, citations: [], text: 42 }), SKILL_TOOL_ERROR_CODES.skillFailed],
  ];

  for (const [label, respond, code] of failingResponses) {
    const native = createRecordingRagService({ respond });
    const expected = await runNatively(skill, {
      args: { question: QUESTION },
      ragService: native.ragService,
    });
    const { chatArguments, skillTool } = createToolFor(skill.id, { respond });
    const message = await skillTool.invoke(toolCall(skill.id, { question: QUESTION }));

    assert.equal(expected.ok, false, label);
    assert.deepStrictEqual(message.artifact, expected, label);
    assert.equal(message.status, "error", label);
    assert.equal(message.content, code, label);
    assert.equal(message.tool_call_id, "call-1", label);
    assert.equal(message.name, skill.id, label);
    assert.equal(JSON.stringify(message.content).includes("CONFIDENTIAL"), false, label);
    assert.deepStrictEqual(chatArguments, native.chatArguments, label);

    // Plain arguments cannot carry a status: the failure is thrown, with the
    // code and without the error's text.
    await assert.rejects(skillTool.invoke({ question: QUESTION }), (error) => {
      assert.equal(error.code, SKILL_TOOL_ERROR_CODES.skillFailed, label);
      assert.equal(error.skillErrorCode, code, label);
      assert.equal(error.message.includes("CONFIDENTIAL"), false, label);
      return true;
    });
  }
});

test("a succeeding Skill's ToolMessage keeps status success", async () => {
  const { skillTool } = createToolFor(CUSTOM_SKILL_IDS.riskReview);
  const message = await skillTool.invoke(toolCall(CUSTOM_SKILL_IDS.riskReview, { question: QUESTION }));

  assert.equal(message.status, "success");
  assert.equal(message.artifact.ok, true);
});

test("a Skill the catalog does not authorize yields no tool", () => {
  const { ragService } = createRecordingRagService();
  const legacyCustomSkill = {
    budgetKey: "customSkillCalls",
    execute: async () => ({ abstained: false, citations: [], text: "legacy" }),
    id: "legacy_custom",
    kind: "custom",
    label: "Legacy Custom",
    match: () => false,
    requiresAccessScope: true,
    version: "1.0.0",
  };
  const registry = createSkillRegistry([...createDefaultSkills(), legacyCustomSkill]);
  const runtime = createRuntime({ ragService, registry });
  const riskReview = registry.get(CUSTOM_SKILL_IDS.riskReview);
  const refused = [
    // A built-in document Skill is not an atomic custom Skill.
    ["built-in", registry.get(AGENT_SKILL_IDS.documentRag), runtime],
    // A custom Skill without an explicit typed contract stays V1-only.
    ["legacy contract", legacyCustomSkill, runtime],
    // A look-alike object is not the registered Skill.
    ["unregistered copy", { ...riskReview }, runtime],
    // One document id the scope cannot see revokes the whole catalog.
    ["foreign document", riskReview, { ...runtime, docIds: ["vendor-msa", "other-tenant-doc"] }],
    ["other scope", riskReview, { ...runtime, accessScope: OTHER_SCOPE }],
    ["no documents", riskReview, { ...runtime, docIds: [] }],
    ["no scope", riskReview, { ...runtime, accessScope: null }],
  ];

  assert.equal(
    createAuthorizedSkillTools({ runtime }).some((skillTool) => skillTool.name === "legacy_custom"),
    false
  );

  for (const [label, skill, refusedRuntime] of refused) {
    assert.throws(
      () => createSkillTool({ runtime: refusedRuntime, skill }),
      (error) => error.code === SKILL_TOOL_ERROR_CODES.notAuthorized,
      label
    );

    if (refusedRuntime !== runtime) {
      assert.deepEqual(createAuthorizedSkillTools({ runtime: refusedRuntime }), [], label);
    }
  }

  // The authorized Skill itself does get a tool.
  assert.equal(createSkillTool({ runtime, skill: riskReview }).name, CUSTOM_SKILL_IDS.riskReview);
});

test("only allowlisted fields are model-writable: a contract field added later is refused, not offered", async () => {
  const riskReview = createDefaultSkillRegistry().get(CUSTOM_SKILL_IDS.riskReview);
  // A Skill whose contract declares more inputs than question/priorFindings,
  // none of them runtime-owned by name.
  const widened = {
    ...riskReview,
    id: "risk_review_widened",
    inputSchema: {
      ...riskReview.inputSchema,
      topK: { required: false, type: "number" },
      workspaceId: { required: false, type: "string" },
    },
  };
  const registry = createSkillRegistry([...createDefaultSkills(), widened]);
  const { chatArguments, ragService } = createRecordingRagService();
  const skillTool = createSkillTool({ runtime: createRuntime({ ragService, registry }), skill: widened });
  const jsonSchema = toJsonSchema(skillTool.schema);

  assert.deepEqual(MODEL_WRITABLE_SKILL_FIELDS, ["priorFindings", "question"]);
  assert.deepEqual(Object.keys(jsonSchema.properties).sort(), ["priorFindings", "question"]);

  for (const [args, fields] of [
    [{ question: QUESTION, topK: 1_000_000 }, ["topK"]],
    [{ question: QUESTION, workspaceId: "other-workspace" }, ["workspaceId"]],
  ]) {
    await assert.rejects(skillTool.invoke(toolCall(widened.id, args)), (error) => {
      assert.equal(error.code, SKILL_TOOL_ERROR_CODES.runtimeField);
      assert.deepEqual(error.fields, fields);
      return true;
    });
  }

  assert.deepEqual(chatArguments, []);

  // The allowlisted fields still work for it.
  const message = await skillTool.invoke(toolCall(widened.id, { question: QUESTION }));

  assert.equal(message.artifact.ok, true);
  assert.equal(chatArguments.length, 1);
});

test("the runtime is read once: changing the runtime object after the tool is built changes nothing", async () => {
  const skill = createDefaultSkillRegistry().get(CUSTOM_SKILL_IDS.riskReview);
  const native = createRecordingRagService();
  const expected = await runNatively(skill, { args: { question: QUESTION }, ragService: native.ragService });
  const authorized = createRecordingRagService();
  const intruder = createRecordingRagService();
  const runtime = createRuntime({ ragService: authorized.ragService });
  const [skillTool] = createAuthorizedSkillTools({ runtime }).filter(
    (candidate) => candidate.name === skill.id
  );
  const single = createSkillTool({ runtime, skill: runtime.registry.get(skill.id) });

  // A shared or reused runtime object, changed after authorization.
  runtime.accessScope = OTHER_SCOPE;
  runtime.docIds.push("other-tenant-doc");
  runtime.ragService = intruder.ragService;
  runtime.retrievalPlan = { ...RETRIEVAL_PLAN, retrievalOptions: { topK: 1_000_000 } };
  runtime.sessionId = "forged-session";
  runtime.userId = OTHER_SCOPE.userId;

  for (const built of [skillTool, single]) {
    const message = await built.invoke(toolCall(skill.id, { question: QUESTION }));

    assert.deepStrictEqual(message.artifact, expected);
  }

  assert.deepStrictEqual(authorized.chatArguments, [...native.chatArguments, ...native.chatArguments]);
  assert.equal(authorized.chatArguments[0].options.accessScope, ACCESS_SCOPE);
  assert.deepStrictEqual(intruder.chatArguments, []);
});

test("a tool call that sets a runtime-owned field is refused before the Skill runs", async () => {
  const { chatArguments, skillTool, telemetry } = createToolFor(CUSTOM_SKILL_IDS.riskReview);
  const attempts = [
    // Widening to another tenant's document and scope.
    {
      accessScope: OTHER_SCOPE,
      docIds: ["other-tenant-doc"],
      question: QUESTION,
    },
    // Even a narrowing of the authorized ids is the runtime's decision.
    { docIds: ["vendor-msa"], question: QUESTION },
    // Identity, memory and the retrieval limit are runtime-owned as well.
    {
      memoryWrites: true,
      question: QUESTION,
      retrievalPlan: { ...RETRIEVAL_PLAN, retrievalOptions: { topK: 1_000_000 } },
      sessionId: "forged-session",
      userId: OTHER_SCOPE.userId,
    },
  ];

  for (const args of attempts) {
    const fields = Object.keys(args).filter((fieldName) => fieldName !== "question").sort();

    await assert.rejects(
      skillTool.invoke(toolCall(CUSTOM_SKILL_IDS.riskReview, args)),
      (error) => {
        assert.equal(error.code, SKILL_TOOL_ERROR_CODES.runtimeField);
        assert.deepEqual(error.fields, fields);
        assert.equal(error.message.includes(QUESTION), false);
        return true;
      }
    );
  }

  assert.deepEqual(chatArguments, []);
  assert.deepEqual(telemetry.listDocumentScopes, []);
});

test("runtime fields override model values even when the argument checks are bypassed", async () => {
  const skill = createDefaultSkillRegistry().get(CUSTOM_SKILL_IDS.riskReview);
  const native = createRecordingRagService();
  const expected = await runNatively(skill, {
    args: { question: QUESTION },
    ragService: native.ragService,
  });
  const { chatArguments, skillTool } = createToolFor(skill.id);

  // tool.func is the function tool() wraps: no argument refusal, no schema
  // parse. The Skill still reads the runtime's scope, ids, plan and identity.
  const [content, artifact] = await skillTool.func(
    {
      accessScope: OTHER_SCOPE,
      docIds: ["other-tenant-doc"],
      memoryWrites: true,
      question: QUESTION,
      retrievalPlan: { ...RETRIEVAL_PLAN, retrievalOptions: { topK: 1_000_000 } },
      sessionId: "forged-session",
      userId: OTHER_SCOPE.userId,
    },
    undefined,
    {}
  );

  assert.deepStrictEqual(artifact, expected);
  assert.equal(content, expected.text);
  assert.deepStrictEqual(chatArguments, native.chatArguments);
});

test("a malformed tool call is refused with field paths and codes only", async () => {
  const secret = "CONFIDENTIAL renewal clause text that must not reach an error";
  const { chatArguments, skillTool } = createToolFor(CUSTOM_SKILL_IDS.riskReview);
  const cases = [
    [{ priorFindings: secret, question: 42 }, [{ code: "invalid_type", path: "question" }]],
    [{ priorFindings: secret }, [{ code: "invalid_type", path: "question" }]],
    [{ priorFindings: { text: secret }, question: secret }, [{ code: "invalid_type", path: "priorFindings" }]],
  ];

  for (const [args, issues] of cases) {
    await assert.rejects(
      skillTool.invoke(toolCall(CUSTOM_SKILL_IDS.riskReview, args)),
      (error) => {
        assert.equal(error.code, SKILL_TOOL_ERROR_CODES.inputInvalid);
        assert.deepEqual(error.issues, issues);
        assert.equal(Object.hasOwn(error, "output"), false);
        assert.equal(
          JSON.stringify({ ...error, message: error.message, stack: error.stack }).includes("CONFIDENTIAL"),
          false
        );
        return true;
      }
    );
  }

  assert.deepEqual(chatArguments, []);

  // Why the adapter parses first: LangChain's own parse failure carries the
  // whole argument object, the text included.
  await assert.rejects(
    DynamicStructuredTool.prototype.call.call(skillTool, { priorFindings: secret, question: 42 }),
    (error) => String(error.output).includes(secret)
  );
});

test("an aborted LangChain signal does not detach the call from its running Skill", async () => {
  const gate = createDeferred();
  const started = createDeferred();
  const { chatArguments, skillTool } = createToolFor(CUSTOM_SKILL_IDS.riskReview, {
    respond: async (input) => {
      started.resolve();
      await gate.promise;
      return respondWithEvidence(input);
    },
  });
  const controller = new AbortController();
  let settled = false;
  const pending = skillTool.invoke(toolCall(CUSTOM_SKILL_IDS.riskReview, { question: QUESTION }), {
    signal: controller.signal,
  });

  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await started.promise;
  controller.abort(new Error("a sibling task failed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the call waits for its Skill instead of rejecting on abort");

  gate.resolve();
  const message = await pending;

  assert.equal(message.artifact.ok, true);
  assert.equal(chatArguments.length, 1);

  // A signal that is already aborted when the call starts does not stop or
  // strand it either: the Skill runs once and the call settles.
  const alreadyAborted = new AbortController();

  alreadyAborted.abort(new Error("a sibling task failed"));
  const second = await skillTool.invoke(
    toolCall(CUSTOM_SKILL_IDS.riskReview, { question: QUESTION }),
    { signal: alreadyAborted.signal }
  );

  assert.deepStrictEqual(second.artifact, message.artifact);
  assert.equal(chatArguments.length, 2);
});

test("a plain tool() is detached by its signal: why the adapter drops it", async () => {
  const createPlainTool = () => {
    const gate = createDeferred();
    const started = createDeferred();
    const state = { completed: false };
    const plainTool = tool(
      async () => {
        started.resolve();
        await gate.promise;
        state.completed = true;
        return "done";
      },
      { name: "plain", schema: z.object({}) }
    );

    return { gate, plainTool, started, state };
  };
  const settledWithin = (promise, ms) =>
    Promise.race([
      promise.then(() => "settled", () => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), ms)),
    ]);

  // Aborted mid-flight: the call rejects at once while its function runs on,
  // so the result is lost and a resumed graph would run the work again.
  const midFlight = createPlainTool();
  const controller = new AbortController();
  const pending = midFlight.plainTool.invoke({}, { signal: controller.signal });

  await midFlight.started.promise;
  controller.abort(new Error("a sibling task failed"));
  await assert.rejects(pending);
  assert.equal(midFlight.state.completed, false);
  midFlight.gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(midFlight.state.completed, true);

  // Aborted before the call: @langchain/core 1.2.17 runs the function to the
  // end and then never settles the call at all.
  const preAborted = createPlainTool();
  const aborted = new AbortController();

  aborted.abort(new Error("a sibling task failed"));
  const stranded = preAborted.plainTool.invoke({}, { signal: aborted.signal });

  await preAborted.started.promise;
  preAborted.gate.resolve();
  assert.equal(await settledWithin(stranded, 50), "pending");
  assert.equal(preAborted.state.completed, true);
});

test("the request deadline still cancels a tool call before its Skill starts", async () => {
  const skill = createDefaultSkillRegistry().get(CUSTOM_SKILL_IDS.riskReview);
  const native = createRecordingRagService();
  const { chatArguments, skillTool } = createToolFor(skill.id);
  const expired = { deadlineAt: Date.now() - 1 };

  await assert.rejects(
    runWithRequestDeadline(expired, () =>
      runNatively(skill, { args: { question: QUESTION }, ragService: native.ragService })
    ),
    isRequestCancelledError
  );
  await assert.rejects(
    runWithRequestDeadline(expired, () =>
      skillTool.invoke(toolCall(skill.id, { question: QUESTION }))
    ),
    isRequestCancelledError
  );
  assert.deepEqual(native.chatArguments, []);
  assert.deepEqual(chatArguments, []);
});

test("the database tenant of the calling request reaches the Skill through the tool", async () => {
  const { chatArguments, skillTool } = createToolFor(CUSTOM_SKILL_IDS.riskReview);

  await runWithDatabaseTenant(ACCESS_SCOPE, () =>
    skillTool.invoke(toolCall(CUSTOM_SKILL_IDS.riskReview, { question: QUESTION }))
  );
  await runWithDatabaseTenant(OTHER_SCOPE, () =>
    skillTool.invoke(toolCall(CUSTOM_SKILL_IDS.riskReview, { question: QUESTION }))
  );
  await skillTool.invoke(toolCall(CUSTOM_SKILL_IDS.riskReview, { question: QUESTION }));

  assert.deepEqual(
    chatArguments.map(({ tenant }) => tenant),
    [
      { userId: ACCESS_SCOPE.userId, workspaceId: ACCESS_SCOPE.workspaceId },
      { userId: OTHER_SCOPE.userId, workspaceId: OTHER_SCOPE.workspaceId },
      null,
    ]
  );
});

test("LangSmith tracing refuses tool creation and every call before LangChain runs", async () => {
  const { chatArguments, ragService, skillTool } = createToolFor(CUSTOM_SKILL_IDS.riskReview);
  const runtime = createRuntime({ ragService });
  const skill = runtime.registry.get(CUSTOM_SKILL_IDS.riskReview);
  let toolStarts = 0;
  const callbacks = [{ handleToolStart: () => { toolStarts += 1; } }];
  const isRefusal = (error) => error.code === LANGSMITH_TRACING_ENABLED_CODE;

  // Positive control: with tracing off, LangChain does reach the handler.
  await skillTool.invoke(toolCall(skill.id, { question: QUESTION }), { callbacks });
  await awaitAllCallbacks();
  assert.equal(toolStarts, 1);
  assert.equal(chatArguments.length, 1);

  for (const name of LANGSMITH_TRACING_VARIABLES) {
    await withEnvironmentVariable(name, "true", async () => {
      assert.throws(() => createAuthorizedSkillTools({ runtime }), isRefusal, name);
      assert.throws(() => createSkillTool({ runtime, skill }), isRefusal, name);
      await assert.rejects(
        skillTool.invoke(toolCall(skill.id, { question: QUESTION }), { callbacks }),
        isRefusal,
        name
      );
      await assert.rejects(
        skillTool.call({ question: QUESTION }, { callbacks }),
        isRefusal,
        name
      );
      await assert.rejects(skillTool.func({ question: QUESTION }, undefined, {}), isRefusal, name);
    });
  }

  await awaitAllCallbacks();
  assert.equal(toolStarts, 1, "no LangChain callback ran while tracing was on");
  assert.equal(chatArguments.length, 1, "no Skill ran while tracing was on");

  for (const name of LANGSMITH_TRACING_VARIABLES) {
    assert.equal(Object.hasOwn(process.env, name), false, `${name} restored`);
  }
});
