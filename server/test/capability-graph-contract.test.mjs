import assert from "node:assert/strict";
import test from "node:test";

import {
  createCapabilityRegistry,
  createCapabilityGraphAdapter,
  listCapabilityGraphAdapters,
} from "../rag/capabilities/index.js";
import { createTaskCreateCapability } from "../rag/capabilities/actions.js";
import { createCitationVerifyCapability } from "../rag/capabilities/citation.js";
import { createWebSearchCapability } from "../rag/capabilities/web.js";
import { CAPABILITY_IDS } from "../rag/capabilities/shared.js";
import { getSkillContract } from "../rag/skills/skill-contract.js";

const makeRegistry = ({ createActionTask, webSearch } = {}) =>
  createCapabilityRegistry([
    createWebSearchCapability({
      webChatService: webSearch ?? (async () => ({ text: "Web result" })),
    }),
    createTaskCreateCapability({
      actionTaskService: {
        createActionTask: createActionTask ?? (async () => ({ id: "task-1" })),
      },
    }),
    createCitationVerifyCapability(),
  ]);

test("only registered capabilities with explicit graph contracts get adapters", () => {
  const registry = makeRegistry();
  const adapters = listCapabilityGraphAdapters({ capabilityRegistry: registry });

  assert.deepEqual(
    adapters.map((adapter) => adapter.id),
    ["capability:web.search", "capability:task.create"]
  );
  assert.equal(
    createCapabilityGraphAdapter({
      capabilityId: CAPABILITY_IDS.citationVerify,
      capabilityRegistry: registry,
    }),
    null
  );
  assert.equal(
    createCapabilityGraphAdapter({
      capabilityId: "unknown.capability",
      capabilityRegistry: registry,
    }),
    null
  );

  const web = adapters[0];
  const task = adapters[1];
  assert.equal(getSkillContract(web).effects, "external_read");
  assert.equal(getSkillContract(web).budgetKey, "webSearchCalls");
  assert.equal(getSkillContract(web).replaySafe, false);
  assert.equal(web.approvalMode, "user_confirmation");
  assert.equal(getSkillContract(task).effects, "workspace_write");
  assert.equal(getSkillContract(task).budgetKey, null);
  assert.equal(getSkillContract(task).replaySafe, false);
  assert.equal(task.approvalMode, "user_confirmation");
  assert.equal(Object.hasOwn(task.inputSchema, "taskId"), false);
  assert.equal(Object.hasOwn(task.inputSchema, "approval"), false);
  assert.equal(Object.hasOwn(registry.describe(CAPABILITY_IDS.webSearch), "executionGraph"), false);
});

test("task adapter requires explicit runtime scope before invoking registry", async () => {
  let calls = 0;
  const registry = makeRegistry({
    createActionTask: async () => {
      calls += 1;
      return { id: "task-1" };
    },
  });
  const task = createCapabilityGraphAdapter({
    capabilityId: CAPABILITY_IDS.taskCreate,
    capabilityRegistry: registry,
  });

  await assert.rejects(
    task.execute({ input: { title: "Review contract" } }),
    { name: "CapabilityGraphScopeError" }
  );
  assert.equal(calls, 0);
});

test("web and task adapters preserve capability approval interrupts", async () => {
  let webCalls = 0;
  let taskCalls = 0;
  const registry = makeRegistry({
    webSearch: async () => {
      webCalls += 1;
      return { text: "Web result" };
    },
    createActionTask: async () => {
      taskCalls += 1;
      return { id: "task-1" };
    },
  });
  const web = createCapabilityGraphAdapter({
    capabilityId: CAPABILITY_IDS.webSearch,
    capabilityRegistry: registry,
  });
  const task = createCapabilityGraphAdapter({
    capabilityId: CAPABILITY_IDS.taskCreate,
    capabilityRegistry: registry,
  });

  await assert.rejects(web.execute({ input: { question: "Latest update?" } }), (error) => {
    assert.equal(error.type, "capability_approval_required");
    assert.equal(error.detail.approvalGate.capabilityId, CAPABILITY_IDS.webSearch);
    return true;
  });
  await assert.rejects(
    task.execute({
      accessScope: { userId: "user-1", workspaceId: "workspace-1" },
      input: { title: "Review contract" },
    }),
    (error) => {
      assert.equal(error.type, "capability_approval_required");
      assert.equal(error.detail.approvalGate.capabilityId, CAPABILITY_IDS.taskCreate);
      return true;
    }
  );
  assert.equal(webCalls, 0);
  assert.equal(taskCalls, 0);
});

test("adapter validates projected output and never manufactures missing text", async () => {
  const registry = makeRegistry({
    webSearch: async () => ({ text: "Result", citations: "not an array" }),
  });
  const web = createCapabilityGraphAdapter({
    capabilityId: CAPABILITY_IDS.webSearch,
    capabilityRegistry: registry,
  });

  await assert.rejects(
    web.execute({
      approval: { approved: true },
      input: { question: "Latest update?" },
    }),
    { name: "SkillOutputContractError" }
  );

  const noTextRegistry = makeRegistry({ webSearch: async () => ({ citations: [] }) });
  const noTextWeb = createCapabilityGraphAdapter({
    capabilityId: CAPABILITY_IDS.webSearch,
    capabilityRegistry: noTextRegistry,
  });
  await assert.rejects(
    noTextWeb.execute({
      approval: { approved: true },
      input: { question: "Latest update?" },
    }),
    { name: "SkillOutputContractError" }
  );
});

test("task adapter strips runtime fields, rejects undeclared input, and validates success", async () => {
  const seen = [];
  const registry = makeRegistry({
    createActionTask: async (payload) => {
      seen.push(payload);
      return { id: "task-1", label: payload.input.title };
    },
  });
  const task = createCapabilityGraphAdapter({
    capabilityId: CAPABILITY_IDS.taskCreate,
    capabilityRegistry: registry,
  });
  const accessScope = { userId: "user-1", workspaceId: "workspace-1" };

  await assert.rejects(
    task.execute({
      accessScope,
      input: { title: "Review contract", approval: { approved: true } },
    }),
    { name: "SkillInputContractError" }
  );
  assert.equal(seen.length, 0);

  const result = await task.execute({
    accessScope,
    approval: { approved: true },
    input: { title: "Review contract", description: "Check sections 2 and 3" },
    services: {
      artifactExecution: { idempotencyKey: "runtime-task-id" },
    },
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].accessScope, accessScope);
  assert.deepEqual(seen[0].input, {
    title: "Review contract",
    description: "Check sections 2 and 3",
  });
  assert.equal(seen[0].taskId, "runtime-task-id");
  assert.equal(result.task.id, "task-1");
  assert.deepEqual(result.citations, []);
  assert.equal(result.abstained, false);
});

test("malformed explicit metadata is not inferred into the graph catalog", () => {
  const missingOutput = createWebSearchCapability({
    webChatService: async () => ({ text: "Web result" }),
  });
  delete missingOutput.executionGraph.outputSchema;
  const missingReplay = createTaskCreateCapability({
    actionTaskService: { createActionTask: async () => ({ id: "task-1" }) },
  });
  delete missingReplay.executionGraph.replaySafe;
  const understatedEffect = createTaskCreateCapability({
    actionTaskService: { createActionTask: async () => ({ id: "task-2" }) },
  });
  understatedEffect.id = "task.create.understated";
  understatedEffect.executionGraph.effects = "read_only";
  const unknownBudget = createWebSearchCapability({
    webChatService: async () => ({ text: "Web result" }),
  });
  unknownBudget.id = "web.search.unknown_budget";
  unknownBudget.executionGraph.budgetKey = "unlimitedCalls";
  const parallelApproval = createWebSearchCapability({
    webChatService: async () => ({ text: "Web result" }),
  });
  parallelApproval.id = "web.search.parallel_approval";
  parallelApproval.executionGraph.parallelSafe = true;
  const parallelWrite = createTaskCreateCapability({
    actionTaskService: { createActionTask: async () => ({ id: "task-3" }) },
  });
  parallelWrite.id = "task.create.parallel_write";
  parallelWrite.approvalPolicy = { mode: "direct", writesWorkspace: true };
  parallelWrite.executionGraph.parallelSafe = true;
  const registry = createCapabilityRegistry([
    missingOutput,
    missingReplay,
    understatedEffect,
    unknownBudget,
    parallelApproval,
    parallelWrite,
  ]);

  assert.deepEqual(listCapabilityGraphAdapters({ capabilityRegistry: registry }), []);
});
