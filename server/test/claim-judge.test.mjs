import assert from "node:assert/strict";
import test from "node:test";
import { runAgentRag } from "../rag/agent.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import {
  buildClaimJudgeResponseFormat,
  claimNumbersAppearInEvidence,
  judgeClaimSupport,
  resetClaimJudgeCache,
} from "../rag/self-check/claim-judge.js";
import { evaluateClaimSupport } from "../rag/self-check/evaluate.js";
import {
  buildScopedRagService,
  createEvalTelemetry,
} from "../evaluation/agent-eval-harness.js";
import {
  DEFAULT_ACCESS_SCOPE,
  sameTrajectoryScope as sameScope,
} from "../evaluation/trajectory/checks.js";

const withJudge = (t, mode = "llm") => {
  const previous = process.env.RAG_CLAIM_JUDGE;
  process.env.RAG_CLAIM_JUDGE = mode;
  resetClaimJudgeCache();
  t.after(() => {
    if (previous === undefined) delete process.env.RAG_CLAIM_JUDGE;
    else process.env.RAG_CLAIM_JUDGE = previous;
    resetClaimJudgeCache();
  });
};

const CITATION = {
  docId: "vendor-a",
  evidenceText:
    "The total liability of Vendor A shall not exceed the fees paid in the twelve (12) months preceding the claim.",
  excerpt: "The total liability of Vendor A shall not exceed the fees paid in the twelve (12) months",
  fileName: "vendor-a.pdf",
  pageNumber: 2,
};
const PARAPHRASE = "Vendor A's liability is capped at the fees from the previous twelve months.";

const lexical = (claims, citations = [CITATION]) =>
  evaluateClaimSupport({
    answerText: claims.map((claim) => `${claim} [Source 1]`).join("\n"),
    citations,
  });

// A judge stand-in that answers every claim it is asked about.
const judgeSaying = (supported, calls = []) => async (prompt, options) => {
  calls.push({ options, prompt });
  const claims = [...prompt.matchAll(/^Claim (\d+) /gm)].map((match) => Number(match[1]));
  return {
    modelRoute: { modelId: "judge-model" },
    text: JSON.stringify({
      verdicts: claims.map((claim) => ({ claim, reason: "stated in source 1", supported })),
    }),
  };
};

test("with the judge off, the lexical verdict is returned untouched", async (t) => {
  withJudge(t, "off");
  const calls = [];
  const claimSupport = lexical([PARAPHRASE]);

  const judged = await judgeClaimSupport({
    citations: [CITATION],
    claimSupport,
    complete: judgeSaying(true, calls),
  });

  assert.equal(judged, claimSupport);
  assert.equal(calls.length, 0);
});

test("a paraphrase the lexical check rejects is upgraded when the judge supports it", async (t) => {
  withJudge(t);
  const claimSupport = lexical([PARAPHRASE]);
  assert.equal(claimSupport.claims[0].supported, false, "precondition: lexical rejects it");

  const judged = await judgeClaimSupport({
    citations: [CITATION],
    claimSupport,
    complete: judgeSaying(true),
  });
  const [claim] = judged.claims;

  assert.equal(claim.supported, true);
  assert.deepEqual(claim.supportedSourceRanks, [1]);
  assert.deepEqual(claim.supportedCitedDocIds, ["vendor-a"]);
  assert.deepEqual(claim.missingAnchors, []);
  assert.ok(claim.lexicalMissingAnchors.length > 0, "the lexical reason is kept for the trace");
  assert.equal(judged.supportedClaimCount, claimSupport.supportedClaimCount + 1);
  assert.equal(judged.unsupportedClaimCount, claimSupport.unsupportedClaimCount - 1);
  assert.equal(judged.judge.upgradedClaimCount, 1);
  assert.equal(judged.judge.modelId, "judge-model");
});

test("a number the evidence does not contain is never sent to the judge", async (t) => {
  withJudge(t);
  const calls = [];

  const judged = await judgeClaimSupport({
    citations: [CITATION],
    claimSupport: lexical(["Vendor A's liability is capped at the fees from the previous six months."]),
    complete: judgeSaying(true, calls),
  });

  assert.equal(calls.length, 0);
  assert.equal(judged.claims[0].supported, false);
  assert.equal(judged.judge.numberGuardRejectedCount, 1);
  // The guard reads numbers as the lexical check does.
  assert.equal(claimNumbersAppearInEvidence("twelve months", CITATION.evidenceText), true);
  assert.equal(claimNumbersAppearInEvidence("12.5 months", CITATION.evidenceText), false);
});

test("a claim with an unsound citation stays rejected whatever the judge would say", async (t) => {
  withJudge(t);
  const calls = [];
  const claimSupport = evaluateClaimSupport({
    answerText: `${PARAPHRASE} [Source 4]`,
    citations: [CITATION],
  });
  assert.deepEqual(claimSupport.claims[0].missingSourceRanks, [4]);

  const judged = await judgeClaimSupport({
    citations: [CITATION],
    claimSupport,
    complete: judgeSaying(true, calls),
  });

  assert.equal(calls.length, 0);
  assert.equal(judged.claims[0].supported, false);
});

test("the judge can only confirm a rejection, and a failure keeps the lexical verdict", async (t) => {
  withJudge(t);
  const rejected = await judgeClaimSupport({
    citations: [CITATION],
    claimSupport: lexical([PARAPHRASE]),
    complete: judgeSaying(false),
  });
  assert.equal(rejected.claims[0].supported, false);
  assert.equal(rejected.claims[0].judge.supported, false);

  resetClaimJudgeCache();
  const failed = await judgeClaimSupport({
    citations: [CITATION],
    claimSupport: lexical([PARAPHRASE]),
    complete: async () => {
      throw new Error("model down");
    },
  });
  assert.equal(failed.claims[0].supported, false);
  assert.equal(failed.judge.status, "failed");

  resetClaimJudgeCache();
  const unparseable = await judgeClaimSupport({
    citations: [CITATION],
    claimSupport: lexical([PARAPHRASE]),
    complete: async () => ({ text: "Sure, looks supported to me!" }),
  });
  assert.equal(unparseable.claims[0].supported, false, "no verdict is not a yes");
});

test("a claim the lexical check already supports is never re-judged", async (t) => {
  withJudge(t);
  const calls = [];

  const judged = await judgeClaimSupport({
    citations: [CITATION],
    claimSupport: lexical([
      "The total liability of Vendor A shall not exceed the fees paid in the twelve (12) months preceding the claim.",
    ]),
    complete: judgeSaying(false, calls),
  });

  assert.equal(calls.length, 0);
  assert.equal(judged.claims[0].supported, true);
});

test("the same claim and evidence are judged once", async (t) => {
  withJudge(t);
  const calls = [];

  await judgeClaimSupport({ citations: [CITATION], claimSupport: lexical([PARAPHRASE]), complete: judgeSaying(true, calls) });
  const again = await judgeClaimSupport({ citations: [CITATION], claimSupport: lexical([PARAPHRASE]), complete: judgeSaying(true, calls) });

  assert.equal(calls.length, 1);
  assert.equal(again.claims[0].supported, true);
  assert.equal(again.judge.cachedClaimCount, 1);
});

test("the judge output is constrained to the claims it was asked about", () => {
  const format = buildClaimJudgeResponseFormat([0, 2]);
  const verdict = format.json_schema.schema.properties.verdicts;

  assert.equal(format.json_schema.strict, true);
  assert.deepEqual(verdict.items.properties.claim.enum, [0, 2]);
  assert.equal(verdict.maxItems, 2);
  assert.match(verdict.items.properties.reason.pattern, /\{0,160\}/);
});

test("comparison answers keep their own checks", async (t) => {
  withJudge(t);
  const calls = [];
  const claimSupport = lexical([PARAPHRASE]);

  const judged = await judgeClaimSupport({
    citations: [CITATION],
    claimSupport,
    comparisonAnalysisSummary: { documents: [] },
    complete: judgeSaying(true, calls),
  });

  assert.equal(judged, claimSupport);
  assert.equal(calls.length, 0);
});

test("with the judge on, a correct paraphrase is answered instead of sent back for clarification", async (t) => {
  const answer = `${PARAPHRASE} [Source 1]`;
  configureOpenAIProvider({
    completeText: async (input) =>
      input.startsWith("You check claims")
        ? JSON.stringify({ verdicts: [{ claim: 0, reason: "restates source 1", supported: true }] })
        : answer,
  });
  t.after(() => resetOpenAIProvider());

  const ragService = buildScopedRagService({
    chat: async ({ question }) => ({
      abstained: false,
      citations: [{ ...CITATION, evidenceText: undefined, excerpt: CITATION.evidenceText, rank: 1 }],
      memoryApplied: false,
      resolvedQuery: question,
      text: answer,
    }),
    documents: [{ docId: "vendor-a", fileName: "vendor-a.pdf" }],
    sameScope,
    telemetry: createEvalTelemetry(),
  });
  const ask = () =>
    runAgentRag({
      accessScope: DEFAULT_ACCESS_SCOPE,
      docIds: ["vendor-a"],
      question: "What is the limitation of liability?",
      ragService,
      sessionId: "judge-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      webChatService: async () => ({ text: "" }),
    });

  withJudge(t, "off");
  const lexicalOnly = await ask();
  assert.equal(lexicalOnly.body.agentMode, "clarification");

  withJudge(t, "llm");
  const judged = await ask();
  assert.equal(judged.body.agentMode, "document");
  assert.match(judged.body.agentAnswer, /capped at the fees from the previous twelve months/);
  const selfCheck = judged.body.agentTrace.find((step) => step.type === "self_check");
  assert.equal(selfCheck.detail.claimSupport.judge.upgradedClaimCount, 1);
});
