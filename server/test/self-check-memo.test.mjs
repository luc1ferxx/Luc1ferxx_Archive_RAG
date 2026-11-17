import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { runWithAgentEventSink } from "../rag/agent-event-stream.js";
import { runAgentRag } from "../rag/agent.js";
import {
  createAnswerDraftReleaser,
  runWithAnswerDraftChannel,
} from "../rag/answer-drafts.js";
import { evaluateClaimSupport } from "../rag/self-check/evaluate.js";
import {
  createSelfCheckEvidenceContext,
  getSelfCheckEvidenceContextStats,
  runWithSelfCheckEvidenceContext,
  setClaimSupportObserverForTests,
} from "../rag/self-check/evidence-context.js";
import {
  buildNumericOccurrenceFacts,
  haveSameNumericOccurrences,
} from "../rag/self-check/numeric-facts.js";
import {
  extractNumericOccurrences,
  normalizeNumericSyntax,
  normalizeSearchTextInContext,
} from "../rag/self-check/text.js";
import { normalizeSearchText } from "../rag/text-utils.js";

// The evidence context is an exact memo: evaluateClaimSupport must return the
// same result with it, without it (a disabled context), and with one context
// shared by every fixture below. The fixtures are the claim-support suites
// themselves: they are imported into this process, and every
// evaluateClaimSupport call they make -- directly, through the document
// evidence check, the finalizer, or a whole agent run -- is replayed here at
// the moment it happens, under the same flags.
const disabledContext = createSelfCheckEvidenceContext({ enabled: false });
const sharedContext = createSelfCheckEvidenceContext();
const comparisons = { count: 0, cachedResults: 0, failures: [] };
let replaying = false;

const replay = (input, result) => {
  if (replaying) {
    return;
  }

  replaying = true;

  try {
    const call = (evidenceContext) =>
      evaluateClaimSupport({ ...input, evidenceContext });
    const unmemoised = call(disabledContext);
    const fresh = createSelfCheckEvidenceContext();
    const variants = {
      observed: result,
      freshContext: call(fresh),
      freshContextRepeated: call(fresh),
      sharedContext: call(sharedContext),
      sharedContextRepeated: call(sharedContext),
    };

    comparisons.count += 1;
    comparisons.cachedResults +=
      getSelfCheckEvidenceContextStats(fresh).hits.claimSupport ?? 0;

    for (const [variant, value] of Object.entries(variants)) {
      try {
        assert.deepStrictEqual(value, unmemoised);
      } catch (error) {
        comparisons.failures.push({
          variant,
          answerText: String(input.answerText ?? "").slice(0, 160),
          message: error.message.slice(0, 600),
        });
      }
    }
  } finally {
    replaying = false;
  }
};

setClaimSupportObserverForTests(replay);
after(() => setClaimSupportObserverForTests(null));

const CLAIM_SUPPORT_SUITES = [
  "./claim-support.test.mjs",
  "./grounded-answer-finalizer.test.mjs",
  "./answer-rate-flags.test.mjs",
  "./grouped-source-labels.test.mjs",
  "./source-labels.test.mjs",
  "./comparison-answer-gate.test.mjs",
  // /chat/stream drafts: one claim check per completed answer prefix.
  "./answer-drafts.test.mjs",
];

// Each suite is imported inside its own describe block, so its tests run in
// that suite and its file-level hooks (environment pins, temporary data
// directories) stay scoped to it, as they are when the file runs alone. A
// describe block, not a test: a suite runs every test registered while it is
// built, while Node before 24 cancels subtests a test function did not await
// ("test did not finish before its parent"; reproduced on Node 20, and CI runs
// Node 22). Node 24 waits for them, so a local run there does not show it.
for (const suite of CLAIM_SUPPORT_SUITES) {
  describe(`claim-support fixtures: ${suite}`, async () => {
    await import(suite);
  });
}

const POLICY_CITATION = {
  docId: "doc-1",
  fileName: "policy.pdf",
  pageNumber: 2,
  excerpt:
    "Remote work requires manager approval before the first remote day.\nEmployees receive a stipend of 500 dollars per year.\nThe notice period is thirty (30) days.",
};

test("memoised claim support equals the unmemoised result for every claim-support fixture", () => {
  assert.ok(
    comparisons.count >= 200,
    `expected the imported suites to exercise at least 200 claim checks, saw ${comparisons.count}`
  );
  assert.ok(comparisons.cachedResults >= comparisons.count);
  assert.deepStrictEqual(comparisons.failures, []);

  const stats = getSelfCheckEvidenceContextStats(sharedContext);

  assert.ok(stats.hits.claimSupport > 0);
  assert.ok(stats.hits.normalizeNumericSyntax > 0);
  assert.ok(stats.hits.citationFieldSentences > 0);
});

test("one claim check reuses citation sentences and numeric normalisation across its claims", () => {
  const input = {
    answerText:
      "Remote work requires manager approval. [Source 1] Employees receive a stipend of 500 dollars per year. [Source 1] The notice period is 30 days. [Source 1]",
    citations: [POLICY_CITATION],
  };
  const context = createSelfCheckEvidenceContext();
  const memoised = evaluateClaimSupport({ ...input, evidenceContext: context });
  const plain = evaluateClaimSupport({
    ...input,
    evidenceContext: createSelfCheckEvidenceContext({ enabled: false }),
  });
  const stats = getSelfCheckEvidenceContextStats(context);

  assert.deepStrictEqual(memoised, plain);
  assert.equal(memoised.supportedClaimCount, 3);
  assert.equal(stats.misses.claimSupport, 1);
  assert.ok(stats.hits.citationFieldSentences > stats.misses.citationFieldSentences);
  assert.ok(stats.hits.extractNumericOccurrences > 0);
  assert.ok(stats.hits.citationDocumentAliasEntries > 0);

  // A repeated check returns a copy: mutating it leaves the cached result alone.
  const repeated = evaluateClaimSupport({ ...input, evidenceContext: context });

  assert.deepStrictEqual(repeated, plain);
  assert.notEqual(repeated, memoised);
  repeated.claims[0].supported = false;
  repeated.claims[0].anchors.push("mutated");
  assert.deepStrictEqual(
    evaluateClaimSupport({ ...input, evidenceContext: context }),
    plain
  );
  assert.equal(getSelfCheckEvidenceContextStats(context).misses.claimSupport, 1);
  assert.equal(getSelfCheckEvidenceContextStats(context).hits.claimSupport, 2);
});

test("a changed citation, flag, or repeated citation object is a different claim check", (t) => {
  const context = createSelfCheckEvidenceContext();
  const answerText = "Remote work requires manager approval. [Source 1]";
  const first = evaluateClaimSupport({
    answerText,
    citations: [POLICY_CITATION],
    evidenceContext: context,
  });
  const changedEvidence = evaluateClaimSupport({
    answerText,
    citations: [{ ...POLICY_CITATION, excerpt: "Onsite work is required." }],
    evidenceContext: context,
  });

  assert.equal(first.supportedClaimCount, 1);
  assert.equal(changedEvidence.supportedClaimCount, 0);

  // The same citation object twice is told apart from two equal objects.
  const twoEqual = { answerText, citations: [{ ...POLICY_CITATION }, { ...POLICY_CITATION }] };
  const sameTwice = { answerText, citations: [POLICY_CITATION, POLICY_CITATION] };
  const plainContext = () => createSelfCheckEvidenceContext({ enabled: false });

  assert.deepStrictEqual(
    evaluateClaimSupport({ ...twoEqual, evidenceContext: context }),
    evaluateClaimSupport({ ...twoEqual, evidenceContext: plainContext() })
  );
  assert.deepStrictEqual(
    evaluateClaimSupport({ ...sameTwice, evidenceContext: context }),
    evaluateClaimSupport({ ...sameTwice, evidenceContext: plainContext() })
  );

  const previous = process.env.RAG_CLAIM_SOURCE_INHERITANCE;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.RAG_CLAIM_SOURCE_INHERITANCE;
    } else {
      process.env.RAG_CLAIM_SOURCE_INHERITANCE = previous;
    }
  });
  const inherited = {
    answerText:
      "Remote work requires manager approval.\nEmployees receive a stipend of 500 dollars per year. [Source 1]",
    citations: [POLICY_CITATION],
  };

  for (const value of ["false", "true", "false"]) {
    process.env.RAG_CLAIM_SOURCE_INHERITANCE = value;
    assert.deepStrictEqual(
      evaluateClaimSupport({ ...inherited, evidenceContext: context }),
      evaluateClaimSupport({ ...inherited, evidenceContext: plainContext() })
    );
  }
});

test("numeric normalisation is memoised by exact input, never skipping a second pass", () => {
  const context = createSelfCheckEvidenceContext();
  const value = "twelve (12) months, minus 5 dollars";
  const once = normalizeNumericSyntax(value);
  const twice = normalizeNumericSyntax(once);
  const plain = extractNumericOccurrences(value);
  // extractNumericOccurrences normalises its input, then normalises that
  // output again for the constraints: both passes are cached by their own
  // exact input.
  const memoised = runWithSelfCheckEvidenceContext(context, () => [
    extractNumericOccurrences(value),
    extractNumericOccurrences(value),
  ]);
  const table = context.tables.get("normalizeNumericSyntax");

  assert.deepStrictEqual(memoised, [plain, plain]);
  assert.equal(table.get(value), once);
  assert.equal(table.get(once), twice);
  assert.notEqual(memoised[0], memoised[1]);
  assert.notEqual(memoised[0][0], memoised[1][0]);
});

test("search-text normalisation is memoised in the active context by exact string input", () => {
  const context = createSelfCheckEvidenceContext();
  const value = "Remote-Work  Policy (2024).pdf";
  const memoised = runWithSelfCheckEvidenceContext(context, () => [
    normalizeSearchTextInContext(value),
    normalizeSearchTextInContext(value),
    normalizeSearchTextInContext(undefined),
  ]);

  // Outside the context the call is not counted, or kept, in it.
  assert.equal(normalizeSearchTextInContext(value), normalizeSearchText(value));

  const { hits, misses } = getSelfCheckEvidenceContextStats(context);

  assert.deepEqual(memoised, [normalizeSearchText(value), normalizeSearchText(value), ""]);
  assert.deepEqual([misses.normalizeSearchText, hits.normalizeSearchText], [1, 1]);
  // Anything but a string is normalised as before, failing where it failed.
  assert.throws(() => normalizeSearchText(null), TypeError);
  assert.throws(
    () => runWithSelfCheckEvidenceContext(context, () => normalizeSearchTextInContext(null)),
    TypeError
  );
});

const unmemoisedClaimSupport = (input) =>
  evaluateClaimSupport({
    ...input,
    evidenceContext: createSelfCheckEvidenceContext({ enabled: false }),
  });

test("a claim checked before against the same input is not checked again", () => {
  const context = createSelfCheckEvidenceContext();
  const claim = "Remote work requires manager approval before the first remote day. [Source 1]";
  // [claims checked, claim checks reused] so far in the context.
  const check = (answerText, citations = [POLICY_CITATION]) => {
    const memoised = evaluateClaimSupport({ answerText, citations, evidenceContext: context });
    const { hits, misses } = getSelfCheckEvidenceContextStats(context);

    assert.deepStrictEqual(memoised, unmemoisedClaimSupport({ answerText, citations }));
    return [misses.claimCheck, hits.claimCheck ?? 0];
  };

  assert.deepEqual(check(claim), [1, 0]);
  // In a longer answer the claim is reused and only the new one is checked.
  assert.deepEqual(
    check(`${claim}\nEmployees receive a stipend of 500 dollars per year. [Source 1]`),
    [2, 1]
  );
  // The same words under a section, with other source labels, or against
  // other evidence are another claim check.
  assert.deepEqual(check(`Summary:\n${claim}`), [3, 1]);
  assert.deepEqual(check(claim.replace("[Source 1]", "[Source 1] [Source 2]")), [4, 1]);
  assert.deepEqual(
    check(claim, [{ ...POLICY_CITATION, excerpt: "Onsite work is required." }]),
    [5, 1]
  );
});

const STREAMED_LINES = [
  "Remote work requires manager approval before the first remote day. [Source 1]",
  "Employees receive a stipend of 500 dollars per year. [Source 1]",
  "The notice period is thirty (30) days. [Source 1]",
  "The stipend is paid monthly. [Source 1]",
];

// One attempt of a streamed answer, in five-character pieces; returns the text.
const streamAttempt = (options, lines) => {
  const text = lines.join("\n");

  options.onAttemptStart();
  for (let index = 0; index < text.length; index += 5) {
    options.onTextDelta(text.slice(index, index + 5));
  }

  return text;
};

// Every claim check a draft releaser makes, with [claims in the answer, claims
// checked, claim checks reused] in its memo right after it.
const recordDraftClaimChecks = async (action) => {
  const checks = [];

  setClaimSupportObserverForTests((input, result) => {
    const { hits, misses } = getSelfCheckEvidenceContextStats(input.evidenceContext);

    checks.push({
      context: input.evidenceContext,
      counts: [result.claims.length, misses.claimCheck ?? 0, hits.claimCheck ?? 0],
      input,
      result,
    });
  });

  try {
    await runWithAgentEventSink(() => {}, () => runWithAnswerDraftChannel(action));
  } finally {
    setClaimSupportObserverForTests(replay);
  }

  return checks;
};

test("a streamed answer's drafts check each claim once across the growing prefixes", async () => {
  const checks = await recordDraftClaimChecks(async () => {
    const drafts = createAnswerDraftReleaser({ citations: [POLICY_CITATION] });

    drafts.finish(streamAttempt(drafts.completionOptions, STREAMED_LINES));
  });

  // A check per completed line and one in finish(), all through one memo:
  // each adds one claim, checked once, and reuses every claim before it.
  assert.equal(new Set(checks.map((check) => check.context)).size, 1);
  assert.deepEqual(
    checks.map((check) => check.counts),
    [
      [1, 1, 0],
      [2, 2, 1],
      [3, 3, 3],
      [4, 4, 6],
    ]
  );
  for (const { input, result } of checks) {
    assert.deepStrictEqual(result, unmemoisedClaimSupport(input));
  }
});

test("a retried attempt checks its drafts' claims with a fresh memo", async () => {
  const checks = await recordDraftClaimChecks(async () => {
    const drafts = createAnswerDraftReleaser({ citations: [POLICY_CITATION] });

    // The first attempt fails in its third line; the retry starts over.
    streamAttempt(drafts.completionOptions, [...STREAMED_LINES.slice(0, 2), "The noti"]);
    drafts.finish(streamAttempt(drafts.completionOptions, STREAMED_LINES.slice(0, 2)));
  });

  // The retry's first prefix is the first attempt's first prefix again, yet
  // it is checked anew: nothing carries over from the failed attempt.
  assert.equal(checks.length, 4);
  assert.equal(checks[0].input.answerText, checks[2].input.answerText);
  assert.equal(checks[0].context, checks[1].context);
  assert.equal(checks[2].context, checks[3].context);
  assert.notEqual(checks[0].context, checks[2].context);
  assert.deepEqual(
    checks.map((check) => check.counts),
    [
      [1, 1, 0],
      [2, 2, 1],
      [1, 1, 0],
      [2, 2, 1],
    ]
  );
});

test("numeric fact comparison gets fresh facts on every call", () => {
  const context = createSelfCheckEvidenceContext();
  const claim = "The vendor fee is 500 dollars.";
  const support = "The vendor fee is 500 dollars per year.";
  const options = { claimRoleTerms: ["vendor", "extra"], supportRoleTerms: ["vendor", "annual"] };
  const plain = haveSameNumericOccurrences(claim, support, options);
  const plainFacts = buildNumericOccurrenceFacts(claim);

  // haveSameNumericOccurrences writes role terms onto the facts it builds;
  // the cached facts must not see that write.
  const memoised = runWithSelfCheckEvidenceContext(context, () => [
    haveSameNumericOccurrences(claim, support, options),
    haveSameNumericOccurrences(claim, support, options),
    buildNumericOccurrenceFacts(claim),
  ]);

  assert.deepStrictEqual(memoised, [plain, plain, plainFacts]);
  assert.ok(getSelfCheckEvidenceContextStats(context).hits.buildNumericOccurrenceFacts >= 2);
});

const followUpRagService = ({ primaryText, followUpText }) => {
  const askedQuestions = [];

  return {
    askedQuestions,
    chat: async (_docIds, query) => {
      askedQuestions.push(query);

      return {
        text: askedQuestions.length === 1 ? primaryText : followUpText,
        citations: [
          {
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt: "Remote work requires manager approval before the first remote day.",
          },
        ],
        abstained: false,
        resolvedQuery: query,
        memoryApplied: false,
      };
    },
    listDocuments: () => [{ docId: "doc-1", fileName: "policy.pdf" }],
  };
};

const runAndCountClaimChecks = async (ragService) => {
  const contexts = new Set();
  let calls = 0;

  setClaimSupportObserverForTests((input) => {
    calls += 1;

    if (input.evidenceContext) {
      contexts.add(input.evidenceContext);
    }
  });

  try {
    const response = await runAgentRag({
      ragService,
      webChatService: async () => {
        throw new Error("Web search should not run.");
      },
      question: "What does remote work require?",
      docIds: ["doc-1"],
      sessionId: "session-memo",
      userId: "alice",
      accessScope: { userId: "alice", workspaceId: "workspace-a" },
    });

    return { calls, contexts: [...contexts], response };
  } finally {
    setClaimSupportObserverForTests(replay);
  }
};

test("a /chat without a follow-up runs the claim check once and reuses it in the finalizer", async () => {
  const ragService = followUpRagService({
    primaryText: "Remote work requires manager approval before the first remote day. [Source 1]",
  });
  const { calls, contexts, response } = await runAndCountClaimChecks(ragService);

  assert.equal(response.status, 200);
  assert.equal(ragService.askedQuestions.length, 1);
  assert.equal(contexts.length, 1);

  const stats = getSelfCheckEvidenceContextStats(contexts[0]);

  assert.equal(calls, 2);
  assert.equal(stats.misses.claimSupport, 1);
  assert.equal(stats.hits.claimSupport, 1);
});

test("a /chat with a follow-up checks each answer once across the loop, the selection, and the finalizer", async () => {
  const ragService = followUpRagService({
    primaryText:
      "Remote work requires manager approval. [Source 1] The satellite stipend is 500 dollars. [Source 1]",
    followUpText: "Remote work requires manager approval before the first remote day. [Source 1]",
  });
  const { calls, contexts, response } = await runAndCountClaimChecks(ragService);

  assert.equal(response.status, 200);
  assert.equal(ragService.askedQuestions.length, 2);
  assert.equal(
    response.body.ragAnswer,
    "Remote work requires manager approval before the first remote day. [Source 1]"
  );
  assert.equal(contexts.length, 1);

  const stats = getSelfCheckEvidenceContextStats(contexts[0]);

  // primary check, follow-up check, two selection scores, finalizer
  assert.equal(calls, 5);
  assert.equal(stats.misses.claimSupport, 2);
  assert.equal(stats.hits.claimSupport, 3);
});
