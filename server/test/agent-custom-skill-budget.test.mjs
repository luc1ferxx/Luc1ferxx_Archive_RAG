import "./langgraph-support/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";

import { runAgentRag } from "../rag/agent.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { AGENT_SKILL_GRAPH_ROLLOUT_REMOVED_CODE } from "../rag/config.js";

// What a /chat-shaped run answers when the custom-Skill stage cannot simply run
// every Skill the intent selected: the call budget covers only some of them,
// covers none, or the selected documents cannot be verified for the caller.
//
// The request is the contract review, which selects two Skills (summarize the
// contract, then review its risks). Everything is the shipped default: the
// default registry and planners, an in-memory run store, and a RAG stub whose
// getDocument is the lookup /chat itself runs before the agent starts.
//
// The V1 sequential chain used to answer three of these cases (ADR 0001 phase
// 8 deleted it). The commit before the deletion pinned what the chain
// answered, in this file; where an expectation below differs from that, the
// comment on the test says how.

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

const runContractReview = async ({
  agentBudget = null,
  rag = null,
  skillGraphRollout = null,
  withDocumentLookup = true,
} = {}) => {
  rag ??= createRagService({ withDocumentLookup });

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

// The chain answered this request with the same response body (the pinned
// comparison held on every field of `answer` and `record` except the graph
// event), telling the second Skill about the first one's findings inside a
// rewritten question. The values that selected it now refuse the run.
test("AGENT_SKILL_GRAPH_ROLLOUT=off and shadow, which selected the sequential chain, refuse the run before any Skill is called", async () => {
  for (const removed of ["off", "shadow", " Off "]) {
    const rag = createRagService();

    await assert.rejects(
      runContractReview({ rag, skillGraphRollout: removed }),
      (error) => {
        assert.equal(error.code, AGENT_SKILL_GRAPH_ROLLOUT_REMOVED_CODE, removed);
        assert.match(
          error.message,
          /^AGENT_SKILL_GRAPH_ROLLOUT=(?:off|shadow) was removed \(ADR 0001 phase 8\)/u,
          removed
        );
        return true;
      }
    );
    assert.deepStrictEqual(rag.questions, [], removed);
  }

  // The one value left changes nothing.
  assert.deepStrictEqual(
    (await runContractReview({ skillGraphRollout: "guarded" })).answer,
    BOTH_SKILLS_ANSWER
  );
});

const ABSTAINED_ANSWER = {
  agentAnswer: ABSTENTION,
  agentMode: "skill_chain",
  ragAnswer: ABSTENTION,
  sourceCount: 0,
  status: 200,
};

// The deterministic graph (summarize, then review the risks on its findings)
// is not rejected for the budget when it is planned; the executor reserves one
// call per node at launch and skips the node it cannot pay for.
//
// The caller's answer is what the chain gave: the same text, source count and
// trace step types. Three things in the record differ from the chain's:
// the skipped Skill is no longer listed in agentSkills (the chain listed it as
// failed), the budget note names the reservation ("needed 1"), and the graph
// event says the graph ran and ended partial instead of "rejected, fallback
// v1".
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
      agentSkills: ["summarize_contract:completed"],
      customSkillCallsUsed: 1,
      customSteps: ["custom_skill:summarize_contract:completed"],
      graph: [
        {
          errorCodes: [],
          executed: true,
          fallback: null,
          nodeRuns: ["summarize_contract:completed", "risk_review:skipped"],
          plannerStatus: "selected",
          status: "partial",
        },
      ],
      skipNotes: ["Skipped Risk Review: custom skill budget exhausted (1/1, needed 1)."],
    },
    skillCalls: ["first"],
  });
});

// The caller's answer is what the chain gave (the abstention, no sources).
// The record differs: the chain wrote one budget note per selected Skill and
// listed both as failed; the graph writes one note, for the node whose launch
// found no budget, skips the node that depends on it without a note of its
// own, and lists neither Skill in agentSkills.
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
        "synthesis:completed",
        "self_check:failed",
        "gap_analysis:completed",
        "answer_finalizer:completed",
      ],
    },
    record: {
      agentSkills: [],
      customSkillCallsUsed: 0,
      customSteps: [],
      graph: [
        {
          errorCodes: [],
          executed: true,
          fallback: null,
          nodeRuns: ["summarize_contract:skipped", "risk_review:skipped"],
          plannerStatus: "selected",
          status: "partial",
        },
      ],
      skipNotes: ["Skipped Summarize Contract: custom skill budget exhausted (0/0, needed 1)."],
    },
    skillCalls: [],
  });
});

// A RAG service without getDocument cannot verify the selected document for
// the caller, so no Skill is authorized for a graph and the planner rejects
// the graph whole. Nothing runs in its place: the chain used to run both
// selected Skills here and answer with their findings. Each selected Skill is
// listed as failed, one trace step says why, and the run abstains.
// /chat never gets here: it runs the same lookup before the agent starts and
// answers 404 for a document it cannot find.
test("documents the stage cannot verify for the caller: no Skill runs, and the response says which were not run and why", async () => {
  const outcome = await runContractReview({ withDocumentLookup: false });

  assert.deepStrictEqual(outcome, {
    answer: {
      ...ABSTAINED_ANSWER,
      traceTypes: [
        "plan:completed",
        "query_planner:completed",
        "skill_chain:completed",
        "skill_graph_rejected:skipped",
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
          errorCodes: ["unregistered_capability", "unregistered_capability"],
          executed: false,
          fallback: null,
          nodeRuns: [],
          plannerStatus: "rejected",
          status: "rejected",
        },
      ],
      skipNotes: [
        "Skipped Summarize Contract, Risk Review: no legal execution graph (unregistered_capability).",
      ],
    },
    skillCalls: [],
  });
});
