import "./langgraph-support/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";

import { runAgentRag } from "../rag/agent.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";

// What a /chat-shaped run answers when the custom-Skill stage cannot simply run
// every Skill the intent selected: the call budget covers only some of them,
// covers none, or the selected documents cannot be verified for the caller.
//
// The request is the contract review, which selects two Skills (summarize the
// contract, then review its risks). Everything is the shipped default: the
// default registry and planners, an in-memory run store, and a RAG stub whose
// getDocument is the lookup /chat itself runs before the agent starts.

const ACCESS_SCOPE = { userId: "alice", workspaceId: "workspace-a" };
const DOC_ID = "contract-1";
const QUESTION = "Review this contract for risks and key terms.";
const SUMMARY = "Contract Summary\n- Parties: Acme and Beta signed a services agreement. [Source 1]";
const RISKS = "Risk Review\n- Risk: Late notice creates renewal risk. [Source 1]";
const RISK_PROMPT = /^Perform a concise citation-backed risk review/u;
const ABSTENTION = "I do not have enough citation-backed evidence to answer reliably.";

const createRagService = ({ withDocumentLookup = true } = {}) => {
  const questions = [];
  const documents = [{ docId: DOC_ID, fileName: "services-agreement.pdf" }];
  const inScope = (scope) =>
    scope?.userId === ACCESS_SCOPE.userId && scope?.workspaceId === ACCESS_SCOPE.workspaceId;

  return {
    questions,
    service: {
      chat: async (_docIds, question) => {
        questions.push(question);

        return {
          abstained: false,
          citations: [
            {
              docId: DOC_ID,
              excerpt:
                "Acme and Beta signed a services agreement. It renews every 12 months unless either party gives 30 days notice. Late notice creates renewal risk.",
              fileName: "services-agreement.pdf",
              pageNumber: 3,
            },
          ],
          memoryApplied: false,
          resolvedQuery: question,
          text: RISK_PROMPT.test(question) ? RISKS : SUMMARY,
        };
      },
      ...(withDocumentLookup
        ? {
            getDocument: (docId, scope) =>
              inScope(scope) ? documents.find((document) => document.docId === docId) ?? null : null,
          }
        : {}),
      listDocuments: (scope) => (inScope(scope) ? documents : []),
    },
  };
};

// How the second Skill was told about the first one's findings.
const describeUpstream = (question) =>
  /Upstream findings from an earlier step/u.test(question)
    ? "typed input"
    : /Previous skill outputs/u.test(question)
      ? "rewritten question"
      : "none";

const runContractReview = async ({ agentBudget = null, skillGraphRollout = null, withDocumentLookup = true } = {}) => {
  const rag = createRagService({ withDocumentLookup });
  const agentRunService = createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });
  const previous = process.env.AGENT_SKILL_GRAPH_ROLLOUT;

  if (skillGraphRollout === null) {
    delete process.env.AGENT_SKILL_GRAPH_ROLLOUT;
  } else {
    process.env.AGENT_SKILL_GRAPH_ROLLOUT = skillGraphRollout;
  }

  let response;

  try {
    response = await runAgentRag({
      accessScope: ACCESS_SCOPE,
      ...(agentBudget ? { agentBudget } : {}),
      agentRunService,
      docIds: [DOC_ID],
      question: QUESTION,
      ragService: rag.service,
      sessionId: "budget-session",
      userId: ACCESS_SCOPE.userId,
      webChatService: async () => {
        throw new Error("Web search should not run.");
      },
    });
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_SKILL_GRAPH_ROLLOUT;
    } else {
      process.env.AGENT_SKILL_GRAPH_ROLLOUT = previous;
    }
  }

  const run = await agentRunService.getRun({
    accessScope: ACCESS_SCOPE,
    runId: response.body.agentRunId,
  });
  const graphEvents = run.events.filter((event) => event.type === "skill_graph_planned");

  return {
    // What the caller sees.
    answer: {
      agentAnswer: response.body.agentAnswer,
      agentMode: response.body.agentMode,
      ragAnswer: response.body.ragAnswer,
      sourceCount: response.body.ragSources.length,
      status: response.status,
      traceTypes: response.body.agentTrace.map((step) => `${step.type}:${step.status}`),
    },
    // How the response and the run describe what did not run.
    record: {
      agentSkills: response.body.agentSkills.map((skill) => `${skill.skillId}:${skill.status}`),
      customSkillCallsUsed: response.body.agentObservability.budget.used.customSkillCalls,
      customSteps: run.steps
        .filter((step) => step.type === "custom_skill")
        .map((step) => `${step.id}:${step.status}`),
      graph: graphEvents.map(({ payload }) => ({
        errorCodes: payload.errorCodes,
        executed: payload.executed,
        fallback: payload.fallback,
        nodeRuns: payload.nodeRuns.map((nodeRun) => `${nodeRun.nodeId}:${nodeRun.status}`),
        plannerStatus: payload.planner.status,
        status: payload.status,
      })),
      skipNotes: response.body.agentTrace
        .filter((step) => step.status === "skipped")
        .map((step) => step.summary),
    },
    skillCalls: rag.questions.map((question, index) =>
      index === 0 ? "first" : `second: ${describeUpstream(question)}`
    ),
  };
};

const BOTH_SKILLS_ANSWER = {
  agentAnswer: `${SUMMARY}\n\n${RISKS.replace("[Source 1]", "[Source 2]")}`,
  agentMode: "skill_chain",
  ragAnswer: `${SUMMARY}\n\n${RISKS.replace("[Source 1]", "[Source 2]")}`,
  sourceCount: 2,
  status: 200,
  traceTypes: [
    "plan:completed",
    "query_planner:completed",
    "skill_chain:completed",
    "custom_skill:completed",
    "custom_skill:completed",
    "synthesis:completed",
    "self_check:completed",
    "answer_finalizer:completed",
  ],
};

test("the default budget pays for both selected Skills: the graph runs them, the second on the first one's findings", async () => {
  const outcome = await runContractReview();

  assert.deepStrictEqual(outcome, {
    answer: BOTH_SKILLS_ANSWER,
    record: {
      agentSkills: ["summarize_contract:completed", "risk_review:completed"],
      customSkillCallsUsed: 2,
      customSteps: ["custom_skill:summarize_contract:completed", "custom_skill:risk_review:completed"],
      graph: [
        {
          errorCodes: [],
          executed: true,
          fallback: null,
          nodeRuns: ["summarize_contract:completed", "risk_review:completed"],
          plannerStatus: "selected",
          status: "completed",
        },
      ],
      skipNotes: [],
    },
    skillCalls: ["first", "second: typed input"],
  });
});

// The sequential chain (AGENT_SKILL_GRAPH_ROLLOUT=off) answers the same
// request with the same response; it differs in how the second Skill is told
// about the first one's findings, and it records no graph.
test("the sequential chain gives the caller the same answer as the graph", async () => {
  const graph = await runContractReview();
  const chain = await runContractReview({ skillGraphRollout: "off" });

  assert.deepStrictEqual(chain.answer, graph.answer);
  assert.deepStrictEqual(chain.answer, BOTH_SKILLS_ANSWER);
  assert.deepStrictEqual(chain.record, { ...graph.record, graph: [] });
  assert.deepStrictEqual(chain.skillCalls, ["first", "second: rewritten question"]);
});

const ABSTAINED_ANSWER = {
  agentAnswer: ABSTENTION,
  agentMode: "skill_chain",
  ragAnswer: ABSTENTION,
  sourceCount: 0,
  status: 200,
};

// Before any node ran, the planner rejects the two-node graph whole (it needs
// two calls, one remains), and the stage hands the request to the sequential
// chain, which runs the Skills in order until the budget is spent.
test("a budget of one call for two selected Skills: the first runs, the second is skipped for the budget", async () => {
  const outcome = await runContractReview({ agentBudget: { maxCustomSkillCalls: 1 } });

  assert.deepStrictEqual(outcome, {
    answer: {
      agentAnswer: SUMMARY,
      agentMode: "skill_chain",
      ragAnswer: SUMMARY,
      sourceCount: 1,
      status: 200,
      traceTypes: [
        "plan:completed",
        "query_planner:completed",
        "skill_chain:completed",
        "custom_skill:completed",
        "budget_limit:skipped",
        "synthesis:completed",
        "self_check:completed",
        "answer_finalizer:completed",
      ],
    },
    record: {
      agentSkills: ["summarize_contract:completed", "risk_review:failed"],
      customSkillCallsUsed: 1,
      customSteps: ["custom_skill:summarize_contract:completed"],
      graph: [
        {
          errorCodes: ["budget_exceeded"],
          executed: false,
          fallback: "v1",
          nodeRuns: [],
          plannerStatus: "rejected",
          status: "rejected",
        },
      ],
      skipNotes: ["Skipped Risk Review: custom skill budget exhausted (1/1)."],
    },
    skillCalls: ["first"],
  });
});

test("a budget of no calls: no Skill runs and the run abstains", async () => {
  const outcome = await runContractReview({ agentBudget: { maxCustomSkillCalls: 0 } });

  assert.deepStrictEqual(outcome, {
    answer: {
      ...ABSTAINED_ANSWER,
      traceTypes: [
        "plan:completed",
        "query_planner:completed",
        "skill_chain:completed",
        "budget_limit:skipped",
        "budget_limit:skipped",
        "synthesis:completed",
        "self_check:failed",
        "gap_analysis:completed",
        "answer_finalizer:completed",
      ],
    },
    record: {
      agentSkills: ["summarize_contract:failed", "risk_review:failed"],
      customSkillCallsUsed: 0,
      customSteps: [],
      graph: [
        {
          errorCodes: ["budget_exceeded"],
          executed: false,
          fallback: "v1",
          nodeRuns: [],
          plannerStatus: "rejected",
          status: "rejected",
        },
      ],
      skipNotes: [
        "Skipped Summarize Contract: custom skill budget exhausted (0/0).",
        "Skipped Risk Review: custom skill budget exhausted (0/0).",
      ],
    },
    skillCalls: [],
  });
});

// A RAG service without getDocument cannot verify the selected document for
// the caller, so no Skill is authorized for a graph and the planner rejects
// the graph whole. The sequential chain runs the selected Skills anyway.
// /chat never gets here: it runs the same lookup before the agent starts and
// answers 404 for a document it cannot find.
test("documents the stage cannot verify for the caller: the sequential chain runs the selected Skills anyway", async () => {
  const outcome = await runContractReview({ withDocumentLookup: false });

  assert.deepStrictEqual(outcome, {
    answer: BOTH_SKILLS_ANSWER,
    record: {
      agentSkills: ["summarize_contract:completed", "risk_review:completed"],
      customSkillCallsUsed: 2,
      customSteps: ["custom_skill:summarize_contract:completed", "custom_skill:risk_review:completed"],
      graph: [
        {
          errorCodes: ["unregistered_capability", "unregistered_capability"],
          executed: false,
          fallback: "v1",
          nodeRuns: [],
          plannerStatus: "rejected",
          status: "rejected",
        },
      ],
      skipNotes: [],
    },
    skillCalls: ["first", "second: rewritten question"],
  });
});
