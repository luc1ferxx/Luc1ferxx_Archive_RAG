import test from "node:test";
import assert from "node:assert/strict";
import { runAgentRag } from "../rag/agent.js";
import { AGENT_INTENT_IDS } from "../rag/agent-intent-rules.js";
import { createAgentRunService, createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { CUSTOM_SKILL_IDS } from "../rag/skills/registry.js";

const accessScope = { userId: "alice", workspaceId: "workspace-a" };
const docIds = ["doc-a", "doc-b"];
const documents = [
  { docId: "doc-a", fileName: "a.pdf" },
  { docId: "doc-b", fileName: "b.pdf" },
];

const requestField = (field) => ({ field, source: "request" });
const nodeOutput = (nodeId, output) => ({ nodeId, output, source: "node" });
const graphNode = ({ dependsOn = [], inputBindings, nodeId, skillId }) => ({
  dependsOn,
  failurePolicy: "continue",
  inputBindings: inputBindings ?? {
    docIds: requestField("docIds"),
    question: requestField("question"),
  },
  nodeId,
  skillId,
});

const makeRagService = (queries) => ({
  getDocument: (docId, scope) =>
    scope === accessScope ? documents.find((document) => document.docId === docId) ?? null : null,
  listDocuments: () => documents,
  chat: async (_docIds, question) => {
    queries.push(question);

    if (question.includes("risk review")) {
      return {
        abstained: false,
        citations: [{
          docId: "doc-b",
          excerpt: "Contract B omits a termination notice clause.",
          fileName: "b.pdf",
          pageNumber: 1,
        }],
        text: "Risk Review\n- Contract B omits a termination notice clause. [Source 1]",
      };
    }

    if (question.includes("document comparison")) {
      return {
        abstained: false,
        citations: [
          {
            docId: "doc-a",
            excerpt: "Contract A requires 30 days notice.",
            fileName: "a.pdf",
            pageNumber: 1,
          },
          {
            docId: "doc-b",
            excerpt: "Contract B requires 60 days notice.",
            fileName: "b.pdf",
            pageNumber: 1,
          },
        ],
        text: "Document Comparison\n- Contract A requires 30 days notice. [Source 1]\n- Contract B requires 60 days notice. [Source 2]",
      };
    }

    return {
      abstained: false,
      citations: [{
        docId: "doc-a",
        excerpt: "Contract A renews on January 1.",
        fileName: "a.pdf",
        pageNumber: 1,
      }],
      text: "Contract A renews on January 1. [Source 1]",
    };
  },
});

test("guarded graph composes compare and risk despite a compare-only intent", async () => {
  const previousMode = process.env.AGENT_SKILL_GRAPH_ROLLOUT;
  process.env.AGENT_SKILL_GRAPH_ROLLOUT = "guarded";
  const queries = [];
  let plannerCapabilities = [];
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });

  try {
    const response = await runAgentRag({
      accessScope,
      agentRunService,
      dagPlannerAdapter: {
        id: "test_dag",
        createExecutionGraph: ({ capabilities }) => {
          plannerCapabilities = capabilities.map((capability) => capability.id);

          return {
            nodes: [
              graphNode({ nodeId: "compare", skillId: CUSTOM_SKILL_IDS.compareDocuments }),
              graphNode({
                dependsOn: ["compare"],
                inputBindings: {
                  docIds: requestField("docIds"),
                  priorFindings: nodeOutput("compare", "text"),
                  question: requestField("question"),
                },
                nodeId: "risk",
                skillId: CUSTOM_SKILL_IDS.riskReview,
              }),
            ],
          };
        },
      },
      docIds,
      intentPlannerAdapter: {
        id: "compare_only_test",
        selectIntentPlan: async () => ({ selectedIntentId: AGENT_INTENT_IDS.compareDocuments }),
      },
      question: "Compare documents A and B and review risks.",
      ragService: makeRagService(queries),
      sessionId: "session-dynamic-compare-risk",
      userId: "alice",
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.agentMode, CUSTOM_SKILL_IDS.compareDocuments);
    assert.equal(plannerCapabilities.includes(CUSTOM_SKILL_IDS.riskReview), true);
    assert.equal(queries.length, 2);
    assert.match(response.body.agentAnswer, /30 days notice/);
    assert.match(response.body.agentAnswer, /termination notice clause/);
    assert.deepEqual(
      response.body.agentObservability.selectedSkills.map((skill) => skill.skillId).sort(),
      [CUSTOM_SKILL_IDS.compareDocuments, CUSTOM_SKILL_IDS.riskReview].sort()
    );
    assert.equal(
      response.body.agentObservability.skills.find((skill) => skill.skillId === CUSTOM_SKILL_IDS.riskReview)?.selected,
      true
    );
    const run = await agentRunService.getRun({
      accessScope,
      runId: response.body.agentRunId,
    });
    assert.deepEqual(
      run.plan.selectedSkills.map((skill) => skill.skillId),
      [CUSTOM_SKILL_IDS.compareDocuments],
      "The unchosen catalog Skill must not be preselected in the run snapshot."
    );
  } finally {
    if (previousMode === undefined) {
      delete process.env.AGENT_SKILL_GRAPH_ROLLOUT;
    } else {
      process.env.AGENT_SKILL_GRAPH_ROLLOUT = previousMode;
    }
  }
});

test("ordinary document QA does not execute the entire catalog when DAG planning fails", async () => {
  const previousMode = process.env.AGENT_SKILL_GRAPH_ROLLOUT;
  process.env.AGENT_SKILL_GRAPH_ROLLOUT = "guarded";
  const queries = [];
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });

  try {
    const response = await runAgentRag({
      accessScope,
      agentRunService,
      dagPlannerAdapter: {
        id: "unavailable_dag",
        createExecutionGraph: () => { throw new Error("planner unavailable"); },
      },
      docIds,
      executionPlannerAdapter: {
        id: "forced_custom_then_document",
        createExecutionPlan: () => [
          { id: "custom_skills", condition: "selected_custom_skills" },
          { id: "document_rag", condition: "selected_skill", skillId: "document_rag" },
        ],
      },
      intentPlannerAdapter: {
        id: "document_test",
        selectIntentPlan: async () => ({ selectedIntentId: AGENT_INTENT_IDS.document }),
      },
      question: "When does Contract A renew?",
      ragService: makeRagService(queries),
      sessionId: "session-dynamic-ordinary-qa",
      userId: "alice",
    });

    assert.equal(response.status, 200);
    assert.equal(queries.some((question) => question.includes("document comparison")), false);
    assert.equal(queries.some((question) => question.includes("risk review")), false);
    assert.equal(response.body.agentObservability.selectedSkills.some(
      (skill) => Object.values(CUSTOM_SKILL_IDS).includes(skill.skillId)
    ), false);
    const run = await agentRunService.getRun({
      accessScope,
      runId: response.body.agentRunId,
    });
    const graphEvent = run.events.find((event) => event.type === "skill_graph_planned");
    assert.equal(graphEvent?.payload?.executed, false);
    assert.equal(graphEvent?.payload?.fallback, "v1");
    assert.deepEqual(graphEvent?.payload?.nodeRuns, []);
  } finally {
    if (previousMode === undefined) {
      delete process.env.AGENT_SKILL_GRAPH_ROLLOUT;
    } else {
      process.env.AGENT_SKILL_GRAPH_ROLLOUT = previousMode;
    }
  }
});
