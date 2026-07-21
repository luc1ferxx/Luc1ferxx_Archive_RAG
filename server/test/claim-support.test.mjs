import test from "node:test";
import assert from "node:assert/strict";
import { runAgentRag } from "../rag/agent.js";
import { buildFeedbackRecord } from "../feedback.js";
import { buildFeedbackCorpusFromRecords } from "../evaluation/feedback-corpus.js";
import { finalizeAgentAnswer } from "../rag/agent-finalizer.js";
import { evaluateDocumentEvidence } from "../rag/agent-self-check.js";

test("document evidence check fails when an answer claim is unsupported by citations", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work requires manager approval. [Source 1] The satellite stipend is 500 dollars. [Source 1]",
        citations: [
          {
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt: "Remote work requires manager approval before the first remote day.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.retryRecommended, true);
  assert.equal(check.claimSupport.supportedClaimCount, 1);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
  assert.match(check.reasons.join(" "), /claim lacks citation support/i);
  assert.match(
    check.claimSupport.claims.find((claim) => !claim.supported).text,
    /satellite stipend/i
  );
});

test("document evidence check does not treat a multi-word file name as claim evidence", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work is allowed. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            fileName: "remote-work.pdf",
            excerpt: "Onsite work is allowed.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.supportedClaimCount, 0);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
});

test("document evidence check uses the full retrieved chunk beyond the UI excerpt", () => {
  const prefix = "Background context without the requested rule. ".repeat(8);
  const fullEvidence = `${prefix}Remote work requires manager approval.`;
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work requires manager approval. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            chunkIndex: 4,
            fileName: "policy.pdf",
            excerpt: fullEvidence.slice(0, 220),
          },
        ],
        retrievedContexts: [
          {
            rank: 1,
            docId: "doc-1",
            chunkIndex: 4,
            text: fullEvidence,
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
});

test("document evidence check rejects evidence with the opposite polarity", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work is allowed. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            fileName: "policy.pdf",
            excerpt: "Remote work is not allowed.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.supportedClaimCount, 0);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
});

test("document evidence check binds permission polarity to the matching evidence sentence", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work is allowed. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            fileName: "policy.pdf",
            excerpt:
              "Onsite work is allowed. Remote work is not permitted.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
});

test("document evidence check separates opposite permission clauses in one sentence", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work is allowed. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            fileName: "policy.pdf",
            excerpt:
              "Onsite work is allowed, but remote work is not permitted.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
});

test("document evidence check separates opposite permission clauses joined by and", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work is allowed. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            fileName: "policy.pdf",
            excerpt:
              "Onsite work is allowed and remote work is not permitted.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
});

test("document evidence check does not strip topical file names in multi-document claims", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1", "doc-2"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work allows flexible hours. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            fileName: "remote-work.pdf",
            excerpt: "Employees may choose flexible hours.",
          },
          {
            rank: 2,
            docId: "doc-2",
            fileName: "onsite-policy.pdf",
            excerpt: "Employees must work onsite during core hours.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
});

test("document evidence check ignores pure document labels in structured comparisons", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Summary:",
          "- Employees may work remotely with manager approval in both documents. [Source 1] [Source 2]",
          "Per document:",
          "- handbook-alpha.pdf:",
          "  - Employees may work remotely with manager approval. [Source 1]",
          "- handbook-beta.pdf:",
          "  - Employees may work remotely with manager approval. [Source 2]",
        ].join("\n"),
        citations: [
          {
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            pageNumber: 1,
            excerpt: "Employees may work remotely with manager approval.",
          },
          {
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            pageNumber: 1,
            excerpt: "Employees may work remotely with manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
});

test("document evidence check ignores Chinese comparison headings and full-width labels", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "摘要：",
          "- 两份文档都要求员工远程办公前获得经理批准。[来源 1] [来源 2]",
          "逐文档：",
          "- handbook-alpha.pdf：",
          "  - 员工远程办公前需要获得经理批准。[来源 1]",
          "- handbook-beta.pdf：",
          "  - 员工远程办公前需要获得经理批准。[来源 2]",
          "共同点：",
          "差异：",
          "缺口或不确定性：",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt: "员工远程办公前需要获得经理批准。",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt: "员工远程办公前需要获得经理批准。",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
});

test("document evidence check still rejects unsupported claims ending with a colon", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Remote work requires manager approval. [Source 1]",
          "The satellite stipend is 500 dollars:",
        ].join("\n"),
        citations: [
          {
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt: "Remote work requires manager approval before the first remote day.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.match(
    check.claimSupport.claims.find((claim) => !claim.supported)?.text ?? "",
    /satellite stipend/i
  );
});

test("document evidence check validates claims against their explicit source", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-gamma"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Employees may work remotely 2 days per week with manager approval. [Source 2]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            pageNumber: 1,
            excerpt:
              "Employees may work remotely 2 days per week with manager approval.",
          },
          {
            rank: 2,
            docId: "doc-gamma",
            fileName: "handbook-gamma.pdf",
            pageNumber: 1,
            excerpt:
              "Employees may work remotely 3 days per week with manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.deepEqual(
    check.claimSupport.claims.find((claim) => !claim.supported)?.missingAnchors,
    ["2"]
  );
});

test("document evidence check supports grounded cross-document differences", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-gamma"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Summary:",
          "- Allowed remote days differ: handbook-alpha allows 2 days per week, while handbook-gamma allows 3 days per week. [Source 1] [Source 2]",
          "Per document:",
          "- handbook-alpha: Employees may work remotely 2 days per week with manager approval. [Source 1]",
          "- handbook-gamma: Employees may work remotely 3 days per week with manager approval. [Source 2]",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            pageNumber: 1,
            excerpt:
              "Employees may work remotely 2 days per week with manager approval.",
          },
          {
            rank: 2,
            docId: "doc-gamma",
            fileName: "handbook-gamma.pdf",
            pageNumber: 1,
            excerpt:
              "Employees may work remotely 3 days per week with manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
});

test("document evidence check supports grounded Chinese contrast relations", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text:
          "handbook-alpha 允许每周远程办公 2 天，而 handbook-beta 允许每周远程办公 3 天。[来源 1] [来源 2]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt: "员工允许每周远程办公 2 天。",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt: "员工允许每周远程办公 3 天。",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
  assert.deepEqual(check.claimSupport.claims[0].supportedSourceRanks, [1, 2]);
});

test("document evidence check binds native Chinese document aliases", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text:
          "文档甲允许每周远程工作 2 天，而文档乙允许每周远程工作 3 天。[来源 1] [来源 2]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "文档甲.pdf",
            excerpt: "文档甲允许每周远程工作 2 天。",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "文档乙.pdf",
            excerpt: "文档乙允许每周远程工作 3 天。",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
  assert.deepEqual(check.claimSupport.claims[0].supportedSourceRanks, [1, 2]);
});

test("document evidence check rejects cross-document differences with swapped values", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-gamma"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Allowed remote days differ: handbook-alpha allows 3 days per week, while handbook-gamma allows 2 days per week. [Source 1] [Source 2]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            pageNumber: 1,
            excerpt:
              "Employees may work remotely 2 days per week with manager approval.",
          },
          {
            rank: 2,
            docId: "doc-gamma",
            fileName: "handbook-gamma.pdf",
            pageNumber: 1,
            excerpt:
              "Employees may work remotely 3 days per week with manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.ok(
    check.claimSupport.claims.some(
      (claim) => !claim.supported && claim.missingAnchors.length > 0
    )
  );
});

test("document evidence check requires shared claims to hold in every cited document", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-gamma"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Both handbooks allow remote work 2 days per week with manager approval. [Source 1] [Source 2]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            pageNumber: 1,
            excerpt:
              "Employees may work remotely 2 days per week with manager approval.",
          },
          {
            rank: 2,
            docId: "doc-gamma",
            fileName: "handbook-gamma.pdf",
            pageNumber: 1,
            excerpt:
              "Employees may work remotely 3 days per week with manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.deepEqual(
    check.claimSupport.claims.find((claim) => !claim.supported)?.missingAnchors,
    ["2"]
  );
});

test("document evidence check requires all compared sources for exclusive claims", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-delta"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Only handbook-delta restricts eligibility to full-time engineering employees. [Source 2]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            pageNumber: 1,
            excerpt:
              "Employees may work remotely 2 days per week with manager approval.",
          },
          {
            rank: 2,
            docId: "doc-delta",
            fileName: "handbook-delta.pdf",
            pageNumber: 1,
            excerpt:
              "Only full-time engineering employees may work remotely 2 days per week with manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(
    check.claimSupport.claims.find((claim) => !claim.supported)?.sourceRanks.length,
    1
  );
});

test("document evidence check rejects exclusive claims shared by another source", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-delta"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Only handbook-delta restricts eligibility to full-time engineering employees. [Source 1] [Source 2]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            pageNumber: 1,
            excerpt:
              "Only full-time engineering employees may work remotely 2 days per week with manager approval.",
          },
          {
            rank: 2,
            docId: "doc-delta",
            fileName: "handbook-delta.pdf",
            pageNumber: 1,
            excerpt:
              "Only full-time engineering employees may work remotely 2 days per week with manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
});

test("document evidence check preserves claim support but requires selected-document coverage", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-delta"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Only full-time engineering employees may work remotely 2 days per week with manager approval. [Source 2]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt:
              "Employees may work remotely 2 days per week with manager approval.",
          },
          {
            rank: 2,
            docId: "doc-delta",
            fileName: "handbook-delta.pdf",
            excerpt:
              "Only full-time engineering employees may work remotely 2 days per week with manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
  assert.deepEqual(check.claimSupport.claims[0].supportedSourceRanks, [2]);
  assert.equal(check.citedDocCount, 1);
  assert.equal(check.passed, false);
});

test("relationship claims reject citations that do not contribute evidence", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Both documents require manager approval for remote work. [Source 1] [Source 2] [Source 3]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            pageNumber: 1,
            excerpt: "Remote work requires manager approval.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            pageNumber: 1,
            excerpt: "Remote work requires manager approval.",
          },
          {
            rank: 3,
            docId: "doc-beta",
            pageNumber: 99,
            excerpt: "The cafeteria opens at 8 AM.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.deepEqual(check.claimSupport.claims[0].verifiedSourceRanks, [1, 2]);
  assert.deepEqual(check.claimSupport.claims[0].supportedSourceRanks, []);
});

test("document evidence check rejects an unlabeled factual claim for one document", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work requires manager approval.",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt: "Remote work requires manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
  assert.deepEqual(check.claimSupport.claims[0].supportedSourceRanks, []);
  assert.equal(check.citedDocCount, 0);
  assert.equal(check.passed, false);
});

test("document evidence check rejects unsupported additive details", () => {
  for (const answer of [
    "Remote work requires manager approval with a satellite stipend. [Source 1]",
    "Remote work requires manager approval plus a satellite stipend. [Source 1]",
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations: [
            {
              rank: 1,
              docId: "doc-1",
              excerpt: "Remote work requires manager approval.",
            },
          ],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
    assert.equal(check.passed, false, answer);
  }
});

test("document evidence check binds polarity and anchors to one evidence segment", () => {
  const cases = [
    {
      answer: "Remote work requires manager approval. [Source 1]",
      excerpt:
        "Onsite work requires manager approval. Remote work does not require manager approval.",
    },
    {
      answer: "Remote work is allowed 2 days per week. [Source 1]",
      excerpt:
        "Onsite work is allowed 2 days per week. Remote work is allowed 3 days per week.",
    },
    {
      answer: "Remote work starts May 3. [Source 1]",
      excerpt: "Onsite work starts May 3. Remote work starts May 30.",
    },
  ];

  for (const { answer, excerpt } of cases) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations: [{ rank: 1, docId: "doc-1", excerpt }],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
    assert.equal(check.passed, false, answer);
  }
});

test("document evidence check matches signed and percentage numeric anchors exactly", () => {
  const cases = [
    {
      answer: "The adjustment is -2 dollars. [Source 1]",
      excerpt: "The adjustment is +2 dollars.",
    },
    {
      answer: "The adjustment rate is 10%. [Source 1]",
      excerpt: "The adjustment rate is 10.",
    },
  ];

  for (const { answer, excerpt } of cases) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations: [{ rank: 1, docId: "doc-1", excerpt }],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
  }
});

test("document evidence check accepts exact numeric anchors before sentence punctuation", () => {
  for (const statement of [
    "The limit is 500.",
    "The deadline is May 3.",
    "The multiplier is 2.5.",
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: `${statement} [Source 1]`,
          citations: [{ rank: 1, docId: "doc-1", excerpt: statement }],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 0, statement);
    assert.equal(check.passed, true, statement);
  }
});

test("document evidence check rejects unsupported details behind alternate separators", () => {
  for (const suffix of [
    "& a satellite stipend",
    "/ a satellite stipend",
    ", a satellite stipend",
    "(plus a satellite stipend)",
    "— a satellite stipend",
  ]) {
    const answer = `Remote work requires manager approval ${suffix}. [Source 1]`;
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations: [
            {
              rank: 1,
              docId: "doc-1",
              excerpt: "Remote work requires manager approval.",
            },
          ],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
  }
});

test("document evidence check binds post-predicate subjects to the same evidence segment", () => {
  const cases = [
    {
      answer: "Manager approval is required for remote work. [Source 1]",
      excerpt: "Manager approval is required for onsite work.",
    },
    {
      answer: "Allowed for remote work 2 days per week. [Source 1]",
      excerpt: "Allowed for onsite work 2 days per week.",
    },
    {
      answer: "May 3 is the remote-work deadline. [Source 1]",
      excerpt: "May 3 is the onsite-work deadline.",
    },
  ];

  for (const { answer, excerpt } of cases) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations: [{ rank: 1, docId: "doc-1", excerpt }],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
  }
});

test("document evidence check distinguishes negated prohibition and requirement scope", () => {
  const cases = [
    {
      answer: "Remote work is not prohibited. [Source 1]",
      excerpt: "Remote work is not allowed.",
    },
    {
      answer: "Manager approval is not required for remote work. [Source 1]",
      excerpt: "Employees cannot work remotely without manager approval.",
    },
  ];

  for (const { answer, excerpt } of cases) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations: [{ rank: 1, docId: "doc-1", excerpt }],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
  }
});

test("document evidence check distinguishes obligation and optionality variants", () => {
  const cases = [
    ["Employees shall obtain manager approval. [Source 1]", "Employees may obtain manager approval."],
    ["Manager approval is compulsory. [Source 1]", "Manager approval is optional."],
    ["Manager approval is voluntary. [Source 1]", "Manager approval is required."],
    ["Manager approval is waived. [Source 1]", "Manager approval is required."],
    ["Employees mustn't obtain manager approval. [Source 1]", "Employees must obtain manager approval."],
    ["Employees needn't obtain manager approval. [Source 1]", "Employees need manager approval."],
  ];

  for (const [answer, excerpt] of cases) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations: [{ rank: 1, docId: "doc-1", excerpt }],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
  }
});

test("document evidence check preserves numeric constraint direction", () => {
  const cases = [
    ["Remote work is allowed 2-3 days. [Source 1]", "Remote work is allowed 2 days."],
    ["Remote work is allowed at least 2 days. [Source 1]", "Remote work is allowed up to 2 days."],
    ["The limit is <2 days. [Source 1]", "The limit is >2 days."],
    ["The tolerance is ±2 units. [Source 1]", "The tolerance is 2 units."],
  ];

  for (const [answer, excerpt] of cases) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations: [{ rank: 1, docId: "doc-1", excerpt }],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
  }
});

test("document evidence check rejects lexical and Chinese fact reversals", () => {
  const cases = [
    ["The policy includes health insurance. [Source 1]", "The policy excludes health insurance."],
    ["The policy increases the stipend to 500. [Source 1]", "The policy decreases the stipend to 500."],
    ["Employees are eligible. [Source 1]", "Employees are ineligible."],
    ["员工允许远程工作。[来源 1]", "员工禁止远程工作。"],
    ["合同包含医疗保险。[来源 1]", "合同不包含医疗保险。"],
    ["员工符合资格。[来源 1]", "员工不符合资格。"],
  ];

  for (const [answer, excerpt] of cases) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations: [{ rank: 1, docId: "doc-1", excerpt }],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
  }
});

test("document evidence check binds explicit document aliases to cited sources", () => {
  for (const answer of [
    "Handbook-alpha allows remote work. [Source 2]",
    "Handbook-alpha: remote work is allowed. [Source 2]",
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: {
        ok: true,
        value: {
          text: [
            "Handbook-beta allows remote work. [Source 2]",
            answer,
            "Handbook-alpha allows remote work. [Source 1]",
          ].join("\n"),
          citations: [
            {
              rank: 1,
              docId: "doc-alpha",
              fileName: "handbook-alpha.pdf",
              excerpt: "Remote work is allowed.",
            },
            {
              rank: 2,
              docId: "doc-beta",
              fileName: "handbook-beta.pdf",
              excerpt: "Remote work is allowed.",
            },
          ],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
    assert.equal(check.passed, false, answer);
  }
});

test("document evidence check rejects adverbial cross-document exclusivity", () => {
  for (const answer of [
    "Manager approval is required exclusively under handbook-beta. [Source 2]",
    "Manager approval is required in handbook-beta alone. [Source 2]",
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: {
        ok: true,
        value: {
          text: [
            "Handbook-alpha requires manager approval for remote work. [Source 1]",
            answer,
          ].join("\n"),
          citations: [
            {
              rank: 1,
              docId: "doc-alpha",
              fileName: "handbook-alpha.pdf",
              excerpt: "Remote work requires manager approval.",
            },
            {
              rank: 2,
              docId: "doc-beta",
              fileName: "handbook-beta.pdf",
              excerpt: "Remote work requires manager approval.",
            },
          ],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
    assert.equal(check.passed, false, answer);
  }
});

test("document evidence check rejects generic cross-document exclusivity", () => {
  for (const subject of ["the second policy", "the latter document", "one policy"]) {
    const answer = `Only ${subject} requires director approval. [Source 2]`;
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations: [
            {
              rank: 1,
              docId: "doc-alpha",
              fileName: "handbook-alpha.pdf",
              excerpt: "Remote work requires director approval.",
            },
            {
              rank: 2,
              docId: "doc-beta",
              fileName: "handbook-beta.pdf",
              excerpt: "Remote work requires director approval.",
            },
          ],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
    assert.equal(check.passed, false, answer);
  }
});

test("document evidence check allows source-local only restrictions", () => {
  for (const answer of [
    "Handbook-delta allows only full-time employees to work remotely. [Source 1]",
    "Under handbook-delta, only full-time employees may work remotely. [Source 1]",
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-delta"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations: [
            {
              rank: 1,
              docId: "doc-delta",
              fileName: "handbook-delta.pdf",
              excerpt: "Only full-time employees may work remotely.",
            },
          ],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 0, answer);
    assert.equal(check.passed, true, answer);
  }
});

test("document evidence check allows source-local temporal while clauses", () => {
  const answer = "Employees may listen to music while working remotely. [Source 1]";
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: answer,
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt: "Employees may listen to music while working remotely.",
          },
        ],
      },
    },
  });

  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
  assert.equal(check.passed, true);
});

test("document evidence check does not omit short unlabeled factual lines", () => {
  for (const shortClaim of ["Approved.", "Unlimited.", "Mandatory.", "Eligible."]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: `Remote work requires manager approval. [Source 1]\n${shortClaim}`,
          citations: [
            {
              rank: 1,
              docId: "doc-1",
              excerpt: "Remote work requires manager approval.",
            },
          ],
        },
      },
    });

    assert.equal(check.claimSupport.claims.length, 2, shortClaim);
    assert.equal(check.claimSupport.unsupportedClaimCount, 1, shortClaim);
    assert.equal(check.passed, false, shortClaim);
  }
});

test("document evidence check accepts every directly supporting agreement source", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Both documents require manager approval for remote work. [Source 1] [Source 2] [Source 3] [Source 4]",
        citations: [
          { rank: 1, docId: "doc-alpha", excerpt: "Remote work requires manager approval." },
          { rank: 2, docId: "doc-alpha", excerpt: "Remote work requires manager approval." },
          { rank: 3, docId: "doc-beta", excerpt: "Remote work requires manager approval." },
          { rank: 4, docId: "doc-beta", excerpt: "Remote work requires manager approval." },
        ],
      },
    },
  });

  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
  assert.deepEqual(check.claimSupport.claims[0].supportedSourceRanks, [1, 2, 3, 4]);
  assert.equal(check.passed, true);
});

test("document evidence check accepts analysis-backed no-difference conclusions", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Summary:",
          "- No evidence-backed material differences were found across the selected documents based on the retrieved evidence. [Source 1] [Source 2]",
          "- The retrieved evidence aligns on the key facts below. [Source 1] [Source 2]",
          "Per document:",
          "- handbook-alpha.pdf:",
          "- Employees may work remotely 2 days per week with manager approval. [Source 1]",
          "- Security checklists must be completed before each remote day. [Source 1]",
          "- handbook-beta.pdf:",
          "- Employees may work remotely 2 days per week with manager approval. [Source 2]",
          "- Security checklists must be completed before each remote day. [Source 2]",
          "Agreements:",
          "- Employees may work remotely 2 days per week with manager approval. [Source 1] [Source 2]",
          "- Security checklists must be completed before each remote day. [Source 1] [Source 2]",
          "Differences:",
          "- No conflicting values or conditions were detected in the retrieved evidence. [Source 1] [Source 2]",
        ].join("\n"),
        comparisonAnalysisSummary: {
          comparedDocIds: ["doc-alpha", "doc-beta"],
          explicitConflictPairs: [],
          shouldShortCircuitNoMaterialDifference: true,
        },
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            pageNumber: 1,
            excerpt:
              "Employees may work remotely 2 days per week with manager approval. Security checklists must be completed before each remote day.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            pageNumber: 1,
            excerpt:
              "Employees may work remotely 2 days per week with manager approval. Security checklists must be completed before each remote day.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
});

test("document evidence check rejects no-difference conclusions without conflict-free analysis", () => {
  const citations = [
    {
      rank: 1,
      docId: "doc-alpha",
      fileName: "handbook-alpha.pdf",
      pageNumber: 1,
      excerpt:
        "Remote work policy: employees may work remotely 2 days per week with manager approval.",
    },
    {
      rank: 2,
      docId: "doc-gamma",
      fileName: "handbook-gamma.pdf",
      pageNumber: 1,
      excerpt:
        "Remote work policy: employees may work remotely 3 days per week with manager approval.",
    },
  ];
  const text =
    "The remote work policies have no differences. [Source 1] [Source 2]";
  const withoutSupportedAnalysis = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-gamma"],
    ragResult: {
      ok: true,
      value: {
        text,
        citations,
        comparisonAnalysisSummary: {
          explicitConflictPairs: [],
          shouldShortCircuitNoMaterialDifference: false,
        },
      },
    },
  });
  const withConflict = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-gamma"],
    ragResult: {
      ok: true,
      value: {
        text,
        citations,
        comparisonAnalysisSummary: {
          explicitConflictPairs: [{ leftDocId: "doc-alpha", rightDocId: "doc-gamma" }],
          shouldShortCircuitNoMaterialDifference: true,
        },
      },
    },
  });

  assert.equal(withoutSupportedAnalysis.passed, false);
  assert.equal(withConflict.passed, false);
  assert.equal(withoutSupportedAnalysis.claimSupport.unsupportedClaimCount, 1);
  assert.equal(withConflict.claimSupport.unsupportedClaimCount, 1);
});

test("document evidence check requires explicit matching sources for no-difference conclusions", () => {
  const citations = [
    {
      rank: 1,
      docId: "doc-alpha",
      fileName: "handbook-alpha.pdf",
      excerpt:
        "Employees may work remotely 2 days per week with manager approval.",
    },
    {
      rank: 2,
      docId: "doc-beta",
      fileName: "handbook-beta.pdf",
      excerpt:
        "Employees may work remotely 2 days per week with manager approval.",
    },
  ];
  const comparisonAnalysisSummary = {
    comparedDocIds: ["doc-alpha", "doc-beta"],
    explicitConflictPairs: [],
    shouldShortCircuitNoMaterialDifference: true,
  };
  const withoutSources = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text:
          "No evidence-backed material differences were found based on the retrieved evidence.",
        citations,
        comparisonAnalysisSummary,
      },
    },
  });
  const withStaleSummary = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text:
          "No evidence-backed material differences were found based on the retrieved evidence. [Source 1] [Source 2]",
        citations,
        comparisonAnalysisSummary: {
          ...comparisonAnalysisSummary,
          comparedDocIds: ["doc-gamma", "doc-delta"],
        },
      },
    },
  });

  assert.equal(withoutSources.passed, false);
  assert.equal(withStaleSummary.passed, false);
});

test("document evidence check does not use file metadata as factual support", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "The stipend requires manager approval. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            fileName: "stipend.pdf",
            excerpt: "Remote work requires manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
});

test("document evidence check rejects agreement claims that reverse policy modality", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Both documents explicitly allowed remote work. [Source 1] [Source 2]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt: "Remote work is prohibited.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt: "Remote work is prohibited.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
});

test("document evidence check applies every relationship constraint in a mixed claim", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta", "doc-gamma"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Only handbook-alpha uses director approval, while handbook-beta uses manager approval. [Source 1] [Source 2] [Source 3]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt: "Remote work requires director approval.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt: "Remote work requires manager approval.",
          },
          {
            rank: 3,
            docId: "doc-gamma",
            fileName: "handbook-gamma.pdf",
            excerpt: "Remote work requires director approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
});

test("document evidence check rejects ambiguous duplicate source ranks", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work requires manager approval. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt: "Remote work is prohibited.",
          },
          {
            rank: 1,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt: "Remote work requires manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.deepEqual(
    check.claimSupport.claims[0].ambiguousSourceRanks,
    [1]
  );
});

test("document evidence check validates unsupported claims after the twelfth claim", () => {
  const supportedClaims = Array.from(
    { length: 12 },
    () => "Remote work requires manager approval. [Source 1]"
  );
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: [
          ...supportedClaims,
          "The satellite stipend is 500 dollars. [Source 1]",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt:
              "Remote work requires manager approval before the first remote day.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.supportedClaimCount, 12);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
  assert.match(
    check.claimSupport.claims.find((claim) => !claim.supported)?.text ?? "",
    /satellite stipend/i
  );
});

test("document evidence check rejects compound claims with an unsupported coordinated fact", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Remote work requires manager approval and includes a satellite stipend. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt: "Remote work requires manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.match(
    check.claimSupport.claims.find((claim) => !claim.supported)?.text ?? "",
    /satellite stipend/i
  );
});

test("document evidence check keeps adjacent source-labelled sentences separate", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Remote work requires manager approval. [Source 1] A satellite stipend exists. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt: "Remote work requires manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.claims.length, 2);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
});

test("document evidence check preserves dotted geographic abbreviations in claims", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "U.S. employees are eligible. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt: "Canadian employees are eligible.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.supportedClaimCount, 0);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
  assert.match(check.claimSupport.claims[0].text, /^U\.S\. employees/i);
});

test("document evidence check validates short anchored claims and unknown sources", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Remote work requires manager approval. [Source 1]",
          "500. [Source 999]",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt: "Remote work requires manager approval.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.claims.length, 2);
  assert.deepEqual(check.claimSupport.claims[1].missingSourceRanks, [999]);
});

test("document evidence check matches numeric and month anchors exactly", () => {
  const numeric = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Employees may work remotely 2 days per week. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt: "Employees may work remotely 20 days per week.",
          },
        ],
      },
    },
  });
  const monthDay = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "The deadline is May 3. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt: "The deadline is May 30.",
          },
        ],
      },
    },
  });

  assert.equal(numeric.passed, false);
  assert.deepEqual(numeric.claimSupport.claims[0].missingAnchors, ["2"]);
  assert.equal(monthDay.passed, false);
  assert.ok(monthDay.claimSupport.claims[0].missingAnchors.includes("May 3"));
});

test("document evidence check rejects opposite generic and permission polarity", () => {
  const cases = [
    {
      answer: "Remote work is allowed. [Source 1]",
      evidence: "Remote work may not be permitted.",
    },
    {
      answer: "Remote work is prohibited. [Source 1]",
      evidence: "Remote work is not prohibited.",
    },
    {
      answer: "Remote work requires manager approval. [Source 1]",
      evidence: "Remote work does not require manager approval.",
    },
    {
      answer: "The policy includes equipment reimbursement. [Source 1]",
      evidence: "The policy does not include equipment reimbursement.",
    },
    {
      answer: "Employees may work remotely without manager approval. [Source 1]",
      evidence: "Employees may work remotely with manager approval.",
    },
    {
      answer: "Manager approval is required for remote work. [Source 1]",
      evidence: "Manager approval is optional for remote work.",
    },
    {
      answer: "Manager approval is required for remote work. [Source 1]",
      evidence: "Remote work may proceed independently of manager approval.",
    },
  ];

  for (const { answer, evidence } of cases) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations: [
            {
              rank: 1,
              docId: "doc-1",
              excerpt: evidence,
            },
          ],
        },
      },
    });

    assert.equal(check.passed, false, `${answer} <- ${evidence}`);
  }
});

test("document evidence check rejects false differences with equal grounded values", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Policies differ: handbook-alpha allows 2 days, while handbook-beta allows 2 days. [Source 1] [Source 2]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt: "Employees may work remotely 2 days per week.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt: "Employees may work remotely 2 days per week.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
});

test("document evidence check rejects wording-only differences", () => {
  for (const [leftVerb, rightVerb] of [
    ["requires", "mandates"],
    ["requires", "needs"],
    ["uses", "requires"],
    ["explicitly requires", "formally requires"],
  ]) {
    const answer = `Handbook-alpha ${leftVerb} manager approval, while handbook-beta ${rightVerb} manager approval. [Source 1] [Source 2]`;
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations: [
            {
              rank: 1,
              docId: "doc-alpha",
              fileName: "handbook-alpha.pdf",
              excerpt: "Remote work requires manager approval.",
            },
            {
              rank: 2,
              docId: "doc-beta",
              fileName: "handbook-beta.pdf",
              excerpt: "Remote work requires manager approval.",
            },
          ],
        },
      },
    });

    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
    assert.equal(check.passed, false, answer);
  }
});

test("document evidence check does not treat single-document all as agreement", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "All employees must complete the security checklist. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt: "All employees must complete the security checklist.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
});

test("document evidence check rejects explicit sources that do not contribute", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Employees may work remotely 2 days per week. [Source 1] [Source 2]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            pageNumber: 1,
            excerpt: "Employees may work remotely 2 days per week.",
          },
          {
            rank: 2,
            docId: "doc-1",
            pageNumber: 99,
            excerpt: "The cafeteria opens at 8 AM.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.deepEqual(check.claimSupport.claims[0].supportedSourceRanks, []);
});

test("relationship claims do not credit unrelated chunks in a supporting document", () => {
  const citations = [
    { rank: 1, docId: "doc-a", pageNumber: 1, excerpt: "The policy provides a remote stipend." },
    { rank: 2, docId: "doc-a", pageNumber: 2, excerpt: "The reimbursement amount is 500 dollars." },
    { rank: 3, docId: "doc-a", pageNumber: 99, excerpt: "The cafeteria serves lunch." },
    { rank: 4, docId: "doc-b", pageNumber: 1, excerpt: "The policy provides a remote stipend." },
    { rank: 5, docId: "doc-b", pageNumber: 2, excerpt: "The reimbursement amount is 500 dollars." },
    { rank: 6, docId: "doc-b", pageNumber: 99, excerpt: "The cafeteria serves lunch." },
  ];
  const check = evaluateDocumentEvidence({
    docIds: ["doc-a", "doc-b"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Both documents provide a remote stipend reimbursement amount of 500 dollars. [Source 1] [Source 2] [Source 3] [Source 4] [Source 5] [Source 6]",
        citations,
      },
    },
  });

  assert.equal(check.passed, false);
  assert.deepEqual(check.claimSupport.claims[0].supportedSourceRanks, []);
});

test("analysis-backed no-difference claims provide minimal document coverage", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-a", "doc-b"],
    ragResult: {
      ok: true,
      value: {
        text:
          "No evidence-backed material differences were found based on the retrieved evidence. [Source 1] [Source 2]",
        comparisonAnalysisSummary: {
          comparedDocIds: ["doc-a", "doc-b"],
          explicitConflictPairs: [],
          shouldShortCircuitNoMaterialDifference: true,
        },
        citations: [
          { rank: 1, docId: "doc-a", pageNumber: 1, excerpt: "The same fact." },
          { rank: 2, docId: "doc-b", pageNumber: 1, excerpt: "The same fact." },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.citedDocCount, 2);
  assert.deepEqual(check.claimSupport.claims[0].supportedSourceRanks, [1, 2]);
});

test("agent rag runs follow-up retrieval when claim support check finds unsupported answer claims", async () => {
  const askedQuestions = [];
  const ragService = {
    chat: async (_docIds, query) => {
      askedQuestions.push(query);

      if (askedQuestions.length === 1) {
        return {
          text: "Remote work requires manager approval. [Source 1] The satellite stipend is 500 dollars. [Source 1]",
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
      }

      return {
        text: "Remote work requires manager approval before the first remote day. [Source 1]",
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
    listDocuments: () => [
      {
        docId: "doc-1",
        fileName: "policy.pdf",
      },
    ],
  };

  const response = await runAgentRag({
    ragService,
    webChatService: async () => {
      throw new Error("Web search should not run when document follow-up succeeds.");
    },
    question: "What does remote work require?",
    docIds: ["doc-1"],
    sessionId: "session-1",
    userId: "alice",
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(askedQuestions.length, 2);
  assert.match(askedQuestions[1], /claim lacks citation support/i);
  assert.equal(
    response.body.ragAnswer,
    "Remote work requires manager approval before the first remote day. [Source 1]"
  );

  const selfChecks = response.body.agentTrace.filter(
    (step) => step.type === "self_check"
  );
  assert.equal(selfChecks[0].status, "failed");
  assert.equal(selfChecks[0].detail.claimSupport.unsupportedClaimCount, 1);
  assert.equal(selfChecks[1].status, "completed");
  assert.equal(selfChecks[1].detail.claimSupport.unsupportedClaimCount, 0);

  const gapAnalysis = response.body.agentTrace.find(
    (step) => step.type === "gap_analysis"
  );
  assert.equal(gapAnalysis.status, "completed");
  assert.equal(gapAnalysis.detail.gaps[0].type, "unsupported_claim");
  assert.match(gapAnalysis.detail.gaps[0].claim, /satellite stipend/i);

  const followUpRetrieval = response.body.agentTrace.find(
    (step) => step.type === "follow_up_retrieval"
  );
  assert.equal(followUpRetrieval.status, "completed");
  assert.equal(followUpRetrieval.detail.retrievalPlan.phase, "follow_up");
  assert.deepEqual(
    followUpRetrieval.detail.retrievalPlan.retrievalQueries.map((query) => query.id),
    ["primary", "follow-up-evidence", "follow-up-source-check"]
  );

  const documentObservation = response.body.agentObservability.skills.find(
    (skill) => skill.skillId === "document_rag"
  );
  assert.equal(documentObservation.attempts, 2);
  assert.equal(documentObservation.retryCount, 1);
  assert.equal(documentObservation.followUpCount, 1);
  assert.equal(documentObservation.citationCount, 2);
  assert.equal(documentObservation.budgetUsed, 2);
  assert.equal(response.body.agentObservability.executionLoop.followUpsRun, 1);
  assert.equal(
    response.body.agentObservability.executionLoop.stoppedReason,
    "follow_up_resolved"
  );
  assert.equal(
    response.body.agentObservability.executionLoop.gaps[0].type,
    "unsupported_claim"
  );
  assert.equal(response.body.agentWorkingMemory.goal, "What does remote work require?");
  assert.deepEqual(
    response.body.agentWorkingMemory.checkedQueries.map((query) => query.phase),
    ["primary", "primary", "follow_up", "follow_up", "follow_up"]
  );
  assert.ok(
    response.body.agentWorkingMemory.supportedClaims.some((claim) =>
      /Remote work requires manager approval/i.test(claim.text)
    )
  );
  assert.equal(response.body.agentWorkingMemory.unresolvedGaps.length, 0);
  assert.equal(response.body.agentWorkingMemory.resolvedGaps[0].type, "unsupported_claim");
  assert.equal(
    response.body.agentObservability.workingMemory,
    response.body.agentWorkingMemory
  );
  assert.deepEqual(
    response.body.agentObservability.runs.map((run) => run.phase),
    ["primary", "follow_up"]
  );
});

test("agent rag asks for clarification when follow-up is unavailable", async () => {
  const ragService = {
    chat: async (_docIds, query) => ({
      text: "Remote work requires manager approval. [Source 1] The satellite stipend is 500 dollars. [Source 1]",
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
    }),
    listDocuments: () => [
      {
        docId: "doc-1",
        fileName: "policy.pdf",
      },
    ],
  };

  const response = await runAgentRag({
    agentBudget: {
      maxDocumentRagCalls: 1,
    },
    ragService,
    webChatService: async () => {
      throw new Error("Web search should not run for a non-abstained document answer.");
    },
    question: "What does remote work require?",
    docIds: ["doc-1"],
    sessionId: "session-1",
    userId: "alice",
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, "clarification");
  assert.match(response.body.agentAnswer, /could not verify/i);
  assert.equal(
    response.body.clarification.reason,
    "document_follow_up_budget_exhausted"
  );
  assert.equal(response.body.ragAnswer, response.body.agentAnswer);
  assert.equal(response.body.agentWorkingMemory.checkedQueries.length, 2);
  assert.equal(response.body.agentWorkingMemory.unresolvedGaps[0].type, "unsupported_claim");
  assert.match(
    response.body.agentWorkingMemory.unsupportedClaims[0].text,
    /satellite stipend/i
  );

  const clarificationStep = response.body.agentTrace.find(
    (step) => step.type === "clarification_gate"
  );
  assert.equal(clarificationStep.status, "needs_input");
  assert.equal(
    clarificationStep.detail.reason,
    "document_follow_up_budget_exhausted"
  );
});

test("answer finalizer preserves section headings without counting them as evidence claims", () => {
  const result = finalizeAgentAnswer({
    answerText: [
      "Risk Review",
      "- Risk: Refund approval is required before issuing payment. [Source 1]",
      "- Unsupported: The policy requires CFO approval. [Source 1]",
    ].join("\n"),
    citations: [
      {
        docId: "doc-1",
        fileName: "refund-policy.pdf",
        pageNumber: 4,
        excerpt: "Refund approval is required before issuing payment.",
      },
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.abstained, false);
  assert.match(result.text, /^Risk Review\n/);
  assert.match(result.text, /Refund approval is required/i);
  assert.doesNotMatch(result.text, /CFO approval/i);
  assert.equal(result.claimSupport.supportedClaimCount, 1);
  assert.equal(result.claimSupport.unsupportedClaimCount, 1);
  assert.equal(
    result.claimSupport.claims.find((claim) => claim.heading)?.text,
    "Risk Review"
  );
});

test("answer finalizer preserves analysis-backed no-difference conclusions", () => {
  const result = finalizeAgentAnswer({
    answerText: [
      "Summary:",
      "- No evidence-backed material differences were found across the selected documents based on the retrieved evidence. [Source 1] [Source 2]",
      "- Employees may work remotely 2 days per week with manager approval. [Source 1] [Source 2]",
    ].join("\n"),
    comparisonAnalysisSummary: {
      comparedDocIds: ["doc-alpha", "doc-beta"],
      explicitConflictPairs: [],
      shouldShortCircuitNoMaterialDifference: true,
    },
    citations: [
      {
        rank: 1,
        docId: "doc-alpha",
        fileName: "handbook-alpha.pdf",
        excerpt:
          "Employees may work remotely 2 days per week with manager approval.",
      },
      {
        rank: 2,
        docId: "doc-beta",
        fileName: "handbook-beta.pdf",
        excerpt:
          "Employees may work remotely 2 days per week with manager approval.",
      },
    ],
  });

  assert.equal(result.changed, false);
  assert.equal(result.abstained, false);
  assert.equal(result.claimSupport.unsupportedClaimCount, 0);
  assert.match(result.text, /No evidence-backed material differences/i);
});

test("answer finalizer never appends unrelated citations to a supported relationship", () => {
  const result = finalizeAgentAnswer({
    answerText: [
      "Both documents require manager approval for remote work. [Source 1] [Source 2]",
      "A satellite stipend is provided. [Source 3]",
    ].join("\n"),
    citations: [
      {
        rank: 1,
        docId: "doc-alpha",
        excerpt: "Remote work requires manager approval.",
      },
      {
        rank: 2,
        docId: "doc-beta",
        excerpt: "Remote work requires manager approval.",
      },
      {
        rank: 3,
        docId: "doc-beta",
        excerpt: "The cafeteria opens at 8 AM.",
      },
    ],
  });

  assert.equal(result.changed, true);
  assert.match(result.text, /\[Source 1\].*\[Source 2\]/);
  assert.doesNotMatch(result.text, /\[Source 3\]/);
  assert.doesNotMatch(result.text, /satellite stipend/i);
});

test("answer finalizer preserves every verified source in a multi-document relationship", () => {
  const citations = Array.from({ length: 5 }, (_, index) => ({
    rank: index + 1,
    docId: `doc-${index + 1}`,
    excerpt: "Remote work requires manager approval.",
  }));
  const result = finalizeAgentAnswer({
    answerText: [
      "All documents require manager approval for remote work. [Source 1] [Source 2] [Source 3] [Source 4] [Source 5]",
      "A satellite stipend is provided. [Source 1]",
    ].join("\n"),
    citations,
  });

  assert.equal(result.changed, true);
  for (let rank = 1; rank <= 5; rank += 1) {
    assert.match(result.text, new RegExp(`\\[Source ${rank}\\]`));
  }
  assert.doesNotMatch(result.text, /satellite stipend/i);
});

test("answer finalizer preserves contract summary section headings", () => {
  const result = finalizeAgentAnswer({
    answerText: [
      "Contract Summary",
      "Parties",
      "- Acme Corp and Beta LLC are parties to the services agreement. [Source 1]",
      "Key Terms",
      "- The agreement renews every 12 months unless either party gives 30 days notice. [Source 1]",
      "Obligations",
      "- Beta LLC must provide monthly support reports. [Source 1]",
      "Deadlines",
      "- Unsupported: Payment is due by the fifth business day. [Source 1]",
      "Unknowns",
      "- The payment deadline is not specified. [Source 1]",
    ].join("\n"),
    citations: [
      {
        docId: "doc-1",
        fileName: "services-agreement.pdf",
        pageNumber: 1,
        excerpt: "Acme Corp and Beta LLC are parties to the services agreement. The agreement renews every 12 months unless either party gives 30 days notice. Beta LLC must provide monthly support reports. The payment deadline is not specified.",
      },
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.abstained, false);
  assert.match(result.text, /^Contract Summary\n/);
  assert.match(result.text, /\nParties\n/);
  assert.match(result.text, /\nKey Terms\n/);
  assert.match(result.text, /\nObligations\n/);
  assert.match(result.text, /\nDeadlines\n/);
  assert.match(result.text, /\nUnknowns\n/);
  assert.doesNotMatch(result.text, /fifth business day/i);
  assert.equal(result.claimSupport.supportedClaimCount, 4);
  assert.equal(result.claimSupport.unsupportedClaimCount, 1);
});

test("answer finalizer preserves document comparison section headings", () => {
  const result = finalizeAgentAnswer({
    answerText: [
      "Document Comparison",
      "Common Ground",
      "- Both policies require manager approval for remote work. [Source 1] [Source 2]",
      "Differences",
      "- Policy 2024 allows 2 remote days per week, while Policy 2025 allows 3 remote days per week. [Source 1] [Source 2]",
      "Conflicts",
      "- Unsupported: Policy 2025 provides a 500 dollar remote stipend. [Source 2]",
      "Missing Terms",
      "- No reimbursement term is specified in either policy. [Source 1] [Source 2]",
    ].join("\n"),
    citations: [
      {
        docId: "doc-1",
        fileName: "policy-2024.pdf",
        pageNumber: 1,
        excerpt: "Policy 2024 requires manager approval for remote work and allows 2 remote days per week. No reimbursement term is specified.",
      },
      {
        docId: "doc-2",
        fileName: "policy-2025.pdf",
        pageNumber: 1,
        excerpt: "Policy 2025 requires manager approval for remote work and allows 3 remote days per week. No reimbursement term is specified.",
      },
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.abstained, false);
  assert.match(result.text, /^Document Comparison\n/);
  assert.match(result.text, /\nCommon Ground\n/);
  assert.match(result.text, /\nDifferences\n/);
  assert.match(result.text, /\nConflicts\n/);
  assert.match(result.text, /\nMissing Terms\n/);
  assert.doesNotMatch(result.text, /500 dollar/i);
  assert.equal(result.claimSupport.supportedClaimCount, 3);
  assert.equal(result.claimSupport.unsupportedClaimCount, 1);
});

test("answer finalizer abstains when only a preserved heading is supported", () => {
  const result = finalizeAgentAnswer({
    answerText: "Risk Review",
    citations: [
      {
        docId: "doc-1",
        fileName: "refund-policy.pdf",
        pageNumber: 4,
        excerpt: "Refund approval is required before issuing payment.",
      },
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.abstained, true);
  assert.equal(
    result.text,
    "I do not have enough citation-backed evidence to answer reliably."
  );
  assert.equal(result.claimSupport.supportedClaimCount, 0);
  assert.equal(result.claimSupport.unsupportedClaimCount, 0);
});

test("feedback records and feedback eval metadata retain claim support checks", () => {
  const claimSupport = {
    supportedClaimCount: 1,
    unsupportedClaimCount: 1,
    claims: [
      {
        text: "Remote work requires manager approval.",
        supported: true,
      },
      {
        text: "The satellite stipend is 500 dollars.",
        supported: false,
      },
    ],
  };
  const feedback = buildFeedbackRecord({
    payload: {
      question: "What does remote work require?",
      feedbackType: "hallucination",
      answer: {
        agentAnswer: "Remote work requires manager approval. The satellite stipend is 500 dollars.",
        agentTrace: [
          {
            type: "self_check",
            detail: {
              claimSupport,
            },
          },
        ],
        ragSources: [
          {
            docId: "doc-1",
            fileName: "policy.pdf",
            pageNumber: 2,
            excerpt: "Remote work requires manager approval before the first remote day.",
          },
        ],
      },
      docIds: ["doc-1"],
    },
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
  });

  assert.equal(feedback.claimChecks.length, 1);
  assert.equal(feedback.claimChecks[0].supportedClaimCount, 1);
  assert.equal(feedback.claimChecks[0].unsupportedClaimCount, 1);
  assert.equal(feedback.claimChecks[0].claims[1].supported, false);
  assert.match(feedback.claimChecks[0].claims[1].text, /satellite stipend/i);

  const corpus = buildFeedbackCorpusFromRecords([feedback]);
  assert.deepEqual(corpus.cases[0].metadata.feedback.claimChecks, feedback.claimChecks);
});
