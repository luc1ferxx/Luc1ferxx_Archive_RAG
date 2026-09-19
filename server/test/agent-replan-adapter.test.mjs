import test from "node:test";
import assert from "node:assert/strict";
import { REPLAN_ADAPTER_IDS, replanAdapter } from "../rag/agent-replan-adapter.js";
import { buildReplanContext } from "../rag/agent-replanner.js";
import {
  configureOpenAIProvider,
  resetOpenAIProvider,
} from "../rag/openai.js";

// The model half of a replan. It is allowed to read a redacted context and
// return JSON; it is not allowed to decide whether that JSON takes effect, so
// these tests only cover the prompt it renders and the parse it performs.
// Everything about whether a patch is legal lives in agent-replanner.test.mjs.

const withProvider = async (completeText, callback) => {
  configureOpenAIProvider({ completeText });

  try {
    return await callback();
  } finally {
    resetOpenAIProvider();
  }
};

// Built the way createReplanResult builds it, so these tests cannot pass on a
// context shape production never produces.
const createReplanContext = (overrides = {}) =>
  buildReplanContext({
    authorizedDocIds: ["doc-1"],
    graph: {
      nodes: [{ dependsOn: [], nodeId: "compare", skillId: "compare_documents" }],
      revision: 0,
    },
    nodeRuns: [
      {
        citationCount: 0,
        nodeId: "compare",
        skillId: "compare_documents",
        status: "succeeded",
      },
    ],
    question: "Compare the two contracts.",
    selectedSkills: [{ id: "compare_documents", label: "Compare documents" }],
    trigger: "insufficient_evidence",
    ...overrides,
  });

test("the replan adapter parses a fenced JSON patch", async () => {
  const patch = await withProvider(
    async () =>
      [
        "```json",
        JSON.stringify({
          addNodes: [
            {
              dependsOn: ["compare"],
              nodeId: "timeline",
              skillId: "extract_timeline",
            },
          ],
        }),
        "```",
      ].join("\n"),
    () => replanAdapter.createPatch(createReplanContext())
  );

  assert.deepEqual(
    patch.addNodes.map((node) => node.nodeId),
    ["timeline"]
  );
});

test("the replan adapter recovers JSON a model wrapped in prose", async () => {
  const patch = await withProvider(
    async () =>
      'Here is the revision:\n{"addNodes":[{"nodeId":"risk","skillId":"risk_review"}]}\nHope that helps.',
    () => replanAdapter.createPatch(createReplanContext())
  );

  assert.deepEqual(
    patch.addNodes.map((node) => node.skillId),
    ["risk_review"]
  );
});

test("the replan adapter raises rather than inventing a patch from unusable output", async () => {
  await assert.rejects(
    () =>
      withProvider(async () => "I could not do that.", () =>
        replanAdapter.createPatch(createReplanContext())
      ),
    /not valid JSON/i
  );
});

/**
 * By the time a replan happens the model has seen node outcomes, which makes
 * this the last and most tempting place for an injected instruction to ask who
 * it is acting as. It gets the same redacted view the initial planner did:
 * buildReplanContext names every key it emits, so identity and executable
 * handles do not reach the prompt even when the runtime's own inputs carry them.
 */
test("the replan prompt carries the redacted context and no identity", async () => {
  let renderedPrompt = "";

  await withProvider(
    async (prompt) => {
      renderedPrompt = prompt;

      return JSON.stringify({ addNodes: [] });
    },
    () =>
      replanAdapter.createPatch(
        createReplanContext({
          accessScope: {
            authenticated: true,
            userId: "alice",
            workspaceId: "workspace-a",
          },
          selectedSkills: [
            {
              execute: () => {
                throw new Error("A planner must never hold this.");
              },
              id: "compare_documents",
              label: "Compare documents",
            },
          ],
        })
      )
  );

  assert.ok(renderedPrompt.includes("insufficient_evidence"));
  assert.ok(renderedPrompt.includes("compare_documents"));
  assert.ok(!renderedPrompt.includes("alice"));
  assert.ok(!renderedPrompt.includes("workspace-a"));
  assert.ok(!renderedPrompt.includes("accessScope\":"));
  assert.ok(!renderedPrompt.includes("execute"));
});

test("the replan adapter is identifiable in a trace", () => {
  assert.equal(replanAdapter.id, REPLAN_ADAPTER_IDS.llm);
});
