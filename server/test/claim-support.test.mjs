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

test("document evidence check treats controlled number words as distinct contrast values", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text:
          "handbook-alpha allows two remote days, while handbook-beta allows three remote days. [Source 1] [Source 2]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt: "The handbook allows two remote days.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt: "The handbook allows three remote days.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
});

test("document evidence check supports grouped source labels from model output", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Both documents allow remote work 2 days per week with manager approval. [Source 1 Source 2]",
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
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
  assert.deepEqual(check.claimSupport.claims[0].sourceRanks, [1, 2]);
  assert.deepEqual(check.claimSupport.claims[0].supportedSourceRanks, [1, 2]);
});

test("document evidence check treats document reportive wrappers as attribution, not evidence facts", () => {
  const citations = [
    {
      rank: 1,
      docId: "doc-alpha",
      fileName: "handbook-alpha.pdf",
      excerpt:
        "Employees may work remotely 2 days per week with manager approval. Security checklists must be completed before each remote day.",
    },
    {
      rank: 2,
      docId: "doc-beta",
      fileName: "handbook-beta.pdf",
      excerpt:
        "Employees may work remotely 2 days per week with manager approval. Security checklists must be completed before every remote day.",
    },
  ];
  const supportedAnswers = [
    "Both documents state remote work is 2 days per week with manager approval. [Source 1] [Source 2]",
    "Both documents include the condition \u201cwith manager approval\u201d for remote work. [Source 1] [Source 2]",
    "Both reference manager approval for remote work. [Source 1] [Source 2]",
    "Both require completing a security checklist before each/every remote day. [Source 1] [Source 2]",
    "handbook-alpha states \u201c2 days per week\u201d for remote work. [Source 1]",
  ];

  for (const text of supportedAnswers) {
    const scopedCitations = text.includes("handbook-alpha states")
      ? citations.slice(0, 1)
      : citations;
    const check = evaluateDocumentEvidence({
      docIds: scopedCitations.map((citation) => citation.docId),
      ragResult: {
        ok: true,
        value: {
          text,
          citations: scopedCitations,
        },
      },
    });

    assert.equal(check.passed, true, text);
    assert.equal(check.claimSupport.unsupportedClaimCount, 0, text);
  }
});

test("document reportive wrappers still reject wrong facts and wrong document cardinality", () => {
  const citations = [
    {
      rank: 1,
      docId: "doc-alpha",
      fileName: "handbook-alpha.pdf",
      excerpt: "Employees may work remotely 2 days per week with manager approval.",
    },
    {
      rank: 2,
      docId: "doc-beta",
      fileName: "handbook-beta.pdf",
      excerpt: "Employees may work remotely 2 days per week with manager approval.",
    },
  ];

  for (const text of [
    "Both documents state remote work is 3 days per week with manager approval. [Source 1] [Source 2]",
    "Both documents state remote work is 2 days per week with director approval. [Source 1] [Source 2]",
    "All three documents state remote work is 2 days per week with manager approval. [Source 1] [Source 2]",
    "All thirteen documents state remote work is 2 days per week with manager approval. [Source 1] [Source 2]",
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: citations.map((citation) => citation.docId),
      ragResult: {
        ok: true,
        value: { text, citations },
      },
    });

    assert.equal(check.passed, false, text);
    assert.equal(check.claimSupport.unsupportedClaimCount, 1, text);
  }
});

test("document reportive normalization preserves substantive include predicates", () => {
  const citations = ["alpha", "beta"].map((name, index) => ({
    rank: index + 1,
    docId: `doc-${name}`,
    fileName: `handbook-${name}.pdf`,
    excerpt: "The plan excludes dental coverage.",
  }));
  const check = evaluateDocumentEvidence({
    docIds: citations.map((citation) => citation.docId),
    ragResult: {
      ok: true,
      value: {
        text:
          "Both documents include dental coverage. [Source 1] [Source 2]",
        citations,
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
});

test("document reportive normalization preserves nominal requirement modality", () => {
  const evaluateRequirement = (excerpt) => {
    const citations = ["alpha", "beta"].map((name, index) => ({
      rank: index + 1,
      docId: `doc-${name}`,
      fileName: `handbook-${name}.pdf`,
      excerpt,
    }));

    return evaluateDocumentEvidence({
      docIds: citations.map((citation) => citation.docId),
      ragResult: {
        ok: true,
        value: {
          text:
            "Both documents state the requirement for manager approval for remote work. [Source 1] [Source 2]",
          citations,
        },
      },
    });
  };

  assert.equal(
    evaluateRequirement("Manager approval is required for remote work.").passed,
    true
  );
  assert.equal(
    evaluateRequirement("Manager approval is optional for remote work.").passed,
    false
  );
});

test("document evidence check validates all-document cardinality separately from business numbers", () => {
  const citations = ["alpha", "beta", "gamma"].map((name, index) => ({
    rank: index + 1,
    docId: `doc-${name}`,
    fileName: `handbook-${name}.pdf`,
    excerpt: "Security checklists must be completed before each remote day.",
  }));
  const check = evaluateDocumentEvidence({
    docIds: citations.map((citation) => citation.docId),
    ragResult: {
      ok: true,
      value: {
        text:
          "All three documents state that security checklists must be completed before each remote day. [Source 1] [Source 2] [Source 3]",
        citations,
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
  assert.deepEqual(check.claimSupport.claims[0].supportedSourceRanks, [1, 2, 3]);
  assert.doesNotMatch(check.claimSupport.claims[0].anchors.join(" "), /3/);
});

test("document evidence check rejects unknown ranks inside grouped source labels", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Employees may work remotely 2 days per week. [Source 1 Source 999]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            excerpt: "Employees may work remotely 2 days per week.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.deepEqual(check.claimSupport.claims[0].sourceRanks, [1, 999]);
  assert.deepEqual(check.claimSupport.claims[0].missingSourceRanks, [999]);
});

test("document evidence check binds standalone Both allow claims to two supporting documents", () => {
  const evaluateBothAllow = (citations) =>
    evaluateDocumentEvidence({
      docIds: [...new Set(citations.map((citation) => citation.docId))],
      ragResult: {
        ok: true,
        value: {
          text:
            "Both allow employees to work remotely 2 days per week. [Source 1] [Source 2]" +
            (citations.length > 2 ? " [Source 3]" : ""),
          citations,
        },
      },
    });

  const supporting = evaluateBothAllow([
    {
      rank: 1,
      docId: "doc-alpha",
      excerpt: "Employees may work remotely 2 days per week.",
    },
    {
      rank: 2,
      docId: "doc-beta",
      excerpt: "Employees are allowed to work remotely 2 days per week.",
    },
  ]);
  const oneDocument = evaluateBothAllow([
    {
      rank: 1,
      docId: "doc-alpha",
      excerpt: "Employees may work remotely 2 days per week.",
    },
    {
      rank: 2,
      docId: "doc-alpha",
      excerpt: "Employees are allowed to work remotely 2 days per week.",
    },
  ]);
  const oppositeModality = evaluateBothAllow([
    {
      rank: 1,
      docId: "doc-alpha",
      excerpt: "Employees may work remotely 2 days per week.",
    },
    {
      rank: 2,
      docId: "doc-beta",
      excerpt: "Employees are prohibited from working remotely 2 days per week.",
    },
  ]);
  const wrongNumber = evaluateBothAllow([
    {
      rank: 1,
      docId: "doc-alpha",
      excerpt: "Employees may work remotely 2 days per week.",
    },
    {
      rank: 2,
      docId: "doc-beta",
      excerpt: "Employees may work remotely 3 days per week.",
    },
  ]);
  const unrelatedExtraSource = evaluateBothAllow([
    {
      rank: 1,
      docId: "doc-alpha",
      excerpt: "Employees may work remotely 2 days per week.",
    },
    {
      rank: 2,
      docId: "doc-beta",
      excerpt: "Employees may work remotely 2 days per week.",
    },
    {
      rank: 3,
      docId: "doc-gamma",
      excerpt: "The cafeteria opens at 8 AM.",
    },
  ]);

  assert.equal(supporting.passed, true);
  assert.deepEqual(
    supporting.claimSupport.claims[0].supportedSourceRanks,
    [1, 2]
  );
  assert.equal(oneDocument.passed, false);
  assert.equal(oppositeModality.passed, false);
  assert.equal(wrongNumber.passed, false);
  assert.equal(unrelatedExtraSource.passed, false);
});

test("document evidence check canonicalizes only controlled completion inflections", () => {
  for (const evidence of [
    "Employees must complete the security checklist before remote work.",
    "The security checklist must be completed before remote work.",
    "The policy requires completing the security checklist before remote work.",
    "Security checklist completion is required before remote work.",
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text:
            "Security checklist completion is required before remote work. [Source 1]",
          citations: [{ rank: 1, docId: "doc-1", excerpt: evidence }],
        },
      },
    });

    assert.equal(check.passed, true, evidence);
  }

  for (const evidence of [
    "Completing the security checklist is optional before remote work.",
    "The security checklist is incomplete before remote work.",
    "The policy requires completing security training before remote work.",
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text:
            "Security checklist completion is required before remote work. [Source 1]",
          citations: [{ rank: 1, docId: "doc-1", excerpt: evidence }],
        },
      },
    });

    assert.equal(check.passed, false, evidence);
  }
});

test("document evidence check treats only is or was stated to be as a reportive wrapper", () => {
  const evaluateClaim = ({ claim, evidence }) =>
    evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: `${claim} [Source 1]`,
          citations: [{ rank: 1, docId: "doc-1", excerpt: evidence }],
        },
      },
    });

  assert.equal(
    evaluateClaim({
      claim: "Manager approval is stated to be required for remote work.",
      evidence: "Manager approval is required for remote work.",
    }).passed,
    true
  );
  assert.equal(
    evaluateClaim({
      claim: "Manager approval was stated to be required for remote work.",
      evidence: "Manager approval is required for remote work.",
    }).passed,
    true
  );

  for (const { claim, evidence } of [
    {
      claim: "Manager approval is stated to be required for remote work.",
      evidence: "Director approval is required for remote work.",
    },
    {
      claim: "Manager approval is stated to be required for remote work.",
      evidence: "Manager approval is required for business travel.",
    },
    {
      claim:
        "Manager approval is stated to be required for 2 remote days per week.",
      evidence: "Manager approval is required for 3 remote days per week.",
    },
    {
      claim: "Manager approval is repeatedly stated to be required for remote work.",
      evidence: "Manager approval is required for remote work.",
    },
  ]) {
    assert.equal(evaluateClaim({ claim, evidence }).passed, false, claim);
  }
});

test("document evidence check rejects unbound generic differences and requires explicit distinct values", () => {
  const evaluateContrast = ({ claim, citations }) =>
    evaluateDocumentEvidence({
      docIds: citations.map((citation) => citation.docId),
      ragResult: {
        ok: true,
        value: {
          text: `${claim} [Source 1] [Source 2]`,
          citations,
        },
      },
    });
  const sameApproval = [
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
  ];
  const differentApproval = [
    sameApproval[0],
    {
      rank: 2,
      docId: "doc-beta",
      fileName: "handbook-beta.pdf",
      excerpt: "Remote work requires director approval.",
    },
  ];

  assert.equal(
    evaluateContrast({ claim: "Approval differs.", citations: sameApproval })
      .passed,
    false
  );
  assert.equal(
    evaluateContrast({
      claim: "Approval differs.",
      citations: differentApproval,
    }).passed,
    false
  );
  assert.equal(
    evaluateContrast({
      claim:
        "handbook-alpha requires manager approval, while handbook-beta requires director approval.",
      citations: differentApproval,
    }).passed,
    true
  );
});

test("document evidence check rejects identical facts presented as a Differences section", () => {
  const citations = [
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
  ];
  const evaluateSection = ({ alphaApprover, betaApprover }) =>
    evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: {
        ok: true,
        value: {
          text: [
            "Differences:",
            `- handbook-alpha requires ${alphaApprover} approval. [Source 1]`,
            `- handbook-beta requires ${betaApprover} approval. [Source 2]`,
          ].join("\n"),
          citations:
            betaApprover === "manager"
              ? citations
              : [
                  citations[0],
                  {
                    ...citations[1],
                    excerpt: "Remote work requires director approval.",
                  },
                ],
        },
      },
    });

  const identical = evaluateSection({
    alphaApprover: "manager",
    betaApprover: "manager",
  });
  const distinct = evaluateSection({
    alphaApprover: "manager",
    betaApprover: "director",
  });

  assert.equal(identical.passed, false);
  assert.equal(identical.claimSupport.unsupportedClaimCount, 2);
  assert.equal(distinct.passed, true);
  assert.equal(distinct.claimSupport.unsupportedClaimCount, 0);
});

test("document evidence check rejects numeric contrasts across different fact subjects", () => {
  for (const fixture of [
    {
      claims: [
        "- handbook-alpha allows remote work 2 days. [Source 1]",
        "- handbook-beta allows safety training 3 days. [Source 2]",
      ],
      excerpts: [
        "The handbook allows remote work 2 days.",
        "The handbook allows safety training 3 days.",
      ],
    },
    {
      claims: [
        "- handbook-alpha sets a remote work budget of $500. [Source 1]",
        "- handbook-beta sets a safety training budget of $700. [Source 2]",
      ],
      excerpts: [
        "The handbook sets a remote work budget of $500.",
        "The handbook sets a safety training budget of $700.",
      ],
    },
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: {
        ok: true,
        value: {
          text: ["Differences:", ...fixture.claims].join("\n"),
          citations: [
            {
              rank: 1,
              docId: "doc-alpha",
              fileName: "handbook-alpha.pdf",
              excerpt: fixture.excerpts[0],
            },
            {
              rank: 2,
              docId: "doc-beta",
              fileName: "handbook-beta.pdf",
              excerpt: fixture.excerpts[1],
            },
          ],
        },
      },
    });

    assert.equal(check.passed, false, fixture.claims.join(" "));
    assert.equal(check.claimSupport.unsupportedClaimCount, 2);
  }
});

test("document evidence check keeps Differences active across document subheadings", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "handbook-alpha.pdf:",
          "- handbook-alpha requires manager approval. [Source 1]",
          "handbook-beta.pdf:",
          "- handbook-beta requires manager approval. [Source 2]",
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

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 2);
});

test("document evidence check rejects an unpaired Differences bullet", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Summary:",
          "- handbook-beta requires manager approval. [Source 2]",
          "Differences:",
          "- handbook-alpha requires manager approval. [Source 1]",
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

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
});

test("document evidence check validates every adjacent Differences pair", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-alpha requires manager approval. [Source 1]",
          "- handbook-beta requires manager approval. [Source 2]",
          "- handbook-alpha requires 2 training days. [Source 1]",
          "- handbook-beta requires 3 training days. [Source 2]",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt:
              "Remote work requires manager approval. Remote work requires 2 training days.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt:
              "Remote work requires manager approval. Remote work requires 3 training days.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 4);
});

test("document evidence check invalidates a Differences section before filtering unsupported bullets", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-alpha requires manager approval. [Source 1]",
          "- handbook-beta requires manager approval. [Source 2]",
          "- handbook-alpha provides a satellite stipend. [Source 1]",
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

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 3);
});

test("document evidence check accepts multiple independently valid Differences pairs", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-alpha specifies a remote allowance of 2 days. [Source 1]",
          "- handbook-beta specifies a remote allowance of 3 days. [Source 2]",
          "- handbook-alpha states an equipment budget of $500. [Source 1]",
          "- handbook-beta states an equipment budget of $700. [Source 2]",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt:
              "The handbook specifies a remote allowance of 2 days and states an equipment budget of $500.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt:
              "The handbook specifies a remote allowance of 3 days and states an equipment budget of $700.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
});

test("document evidence check rejects synonymous relation wording as a substantive contrast", () => {
  for (const fixture of [
    {
      answer:
        "handbook-alpha says the approval authority is manager, while handbook-beta says the approver is manager. [Source 1] [Source 2]",
      excerpts: [
        "The approval authority is manager.",
        "The approver is manager.",
      ],
    },
    {
      answer:
        "handbook-alpha uses manager sign-off, while handbook-beta uses manager approval. [Source 1] [Source 2]",
      excerpts: [
        "Remote work uses manager sign-off.",
        "Remote work uses manager approval.",
      ],
    },
    {
      answer:
        "handbook-alpha requires HR approval, while handbook-beta requires human resources approval. [Source 1] [Source 2]",
      excerpts: [
        "Remote work requires HR approval.",
        "Remote work requires human resources approval.",
      ],
    },
    {
      answer:
        "handbook-alpha requires CEO approval, while handbook-beta requires chief executive officer approval. [Source 1] [Source 2]",
      excerpts: [
        "Remote work requires CEO approval.",
        "Remote work requires chief executive officer approval.",
      ],
    },
    {
      answer:
        "handbook-alpha covers U.S. employees, while handbook-beta covers United States employees. [Source 1] [Source 2]",
      excerpts: [
        "The policy covers U.S. employees.",
        "The policy covers United States employees.",
      ],
    },
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: {
        ok: true,
        value: {
          text: fixture.answer,
          citations: [
            {
              rank: 1,
              docId: "doc-alpha",
              fileName: "handbook-alpha.pdf",
              excerpt: fixture.excerpts[0],
            },
            {
              rank: 2,
              docId: "doc-beta",
              fileName: "handbook-beta.pdf",
              excerpt: fixture.excerpts[1],
            },
          ],
        },
      },
    });

    assert.equal(check.passed, false, fixture.answer);
    assert.equal(check.claimSupport.unsupportedClaimCount, 1, fixture.answer);
  }
});

test("explicit document claims cannot use another document citation to fake coverage", () => {
  for (const sourceLabels of [
    "[Source 1 Source 2]",
    "[Source 1] [Source 2]",
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: {
        ok: true,
        value: {
          text: `handbook-alpha requires manager approval. ${sourceLabels}`,
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

    assert.equal(check.passed, false, sourceLabels);
    assert.equal(check.claimSupport.unsupportedClaimCount, 1, sourceLabels);
    assert.deepEqual(
      check.claimSupport.claims[0].verifiedSourceRanks,
      [1],
      sourceLabels
    );
  }
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

test("a document label colon keeps only scoped to the evidence subject", () => {
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
      docId: "doc-delta",
      fileName: "handbook-delta.pdf",
      excerpt:
        "Only full-time engineering employees may work remotely 2 days per week with manager approval.",
    },
  ];
  const check = evaluateDocumentEvidence({
    docIds: citations.map((citation) => citation.docId),
    ragResult: {
      ok: true,
      value: {
        text:
          "handbook-delta: Only full-time engineering employees may work remotely 2 days per week with manager approval. [Source 2]",
        citations,
      },
    },
  });

  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
  assert.deepEqual(check.claimSupport.claims[0].supportedSourceRanks, [2]);
  assert.equal(check.passed, false, "selected-document coverage remains enforced");
});

test("difference sections recognize a supported eligibility-scope restriction", () => {
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
      docId: "doc-delta",
      fileName: "handbook-delta.pdf",
      excerpt:
        "Only full-time engineering employees may work remotely 2 days per week with manager approval.",
    },
  ];
  const check = evaluateDocumentEvidence({
    docIds: citations.map((citation) => citation.docId),
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-alpha: Employees may work remotely 2 days per week with manager approval. [Source 1]",
          "- handbook-delta: Only full-time engineering employees may work remotely 2 days per week with manager approval. [Source 2]",
        ].join("\n"),
        citations,
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
  assert.deepEqual(
    check.claimSupport.claims.flatMap((claim) => claim.supportedSourceRanks),
    [1, 2]
  );
});

test("difference sections preserve eligibility scope through document reportive wrappers", () => {
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
      docId: "doc-delta",
      fileName: "handbook-delta.pdf",
      excerpt:
        "Only full-time engineering employees may work remotely 2 days per week with manager approval.",
    },
  ];
  const check = evaluateDocumentEvidence({
    docIds: citations.map((citation) => citation.docId),
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-alpha states Employees may work remotely 2 days per week with manager approval. [Source 1]",
          "- handbook-delta states Only full-time engineering employees may work remotely 2 days per week with manager approval. [Source 2]",
        ].join("\n"),
        citations,
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
  assert.deepEqual(
    check.claimSupport.claims.flatMap((claim) => claim.supportedSourceRanks),
    [1, 2]
  );
});

test("difference sections do not pair unrelated subjects as an eligibility scope contrast", () => {
  const citations = [
    {
      rank: 1,
      docId: "doc-employees",
      fileName: "handbook-employees.pdf",
      excerpt:
        "Employees may work remotely 2 days per week with manager approval.",
    },
    {
      rank: 2,
      docId: "doc-contractors",
      fileName: "handbook-contractors.pdf",
      excerpt:
        "Only full-time engineering contractors may work remotely 2 days per week with manager approval.",
    },
  ];
  const check = evaluateDocumentEvidence({
    docIds: citations.map((citation) => citation.docId),
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-employees states Employees may work remotely 2 days per week with manager approval. [Source 1]",
          "- handbook-contractors states Only full-time engineering contractors may work remotely 2 days per week with manager approval. [Source 2]",
        ].join("\n"),
        citations,
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 2);
  assert.ok(
    check.claimSupport.claims.every((claim) =>
      claim.missingAnchors.includes("substantive_contrast")
    )
  );
});

test("document reportive normalization still rejects a document-scoped only claim", () => {
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
  const check = evaluateDocumentEvidence({
    docIds: citations.map((citation) => citation.docId),
    ragResult: {
      ok: true,
      value: {
        text:
          "Only handbook-alpha states Employees may work remotely 2 days per week with manager approval. [Source 1] [Source 2]",
        citations,
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 1);
});

test("difference sections do not invent a scope contrast for identical populations", () => {
  const citations = [
    {
      rank: 1,
      docId: "doc-alpha",
      fileName: "handbook-alpha.pdf",
      excerpt:
        "Only full-time engineering employees may work remotely 2 days per week with manager approval.",
    },
    {
      rank: 2,
      docId: "doc-delta",
      fileName: "handbook-delta.pdf",
      excerpt:
        "Only full-time engineering employees may work remotely 2 days per week with manager approval.",
    },
  ];
  const check = evaluateDocumentEvidence({
    docIds: citations.map((citation) => citation.docId),
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-alpha: Only full-time engineering employees may work remotely 2 days per week with manager approval. [Source 1]",
          "- handbook-delta: Only full-time engineering employees may work remotely 2 days per week with manager approval. [Source 2]",
        ].join("\n"),
        citations,
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 2);
  assert.ok(
    check.claimSupport.claims.every((claim) =>
      claim.missingAnchors.includes("substantive_contrast")
    )
  );
});

test("difference sections do not treat a subject reordering as a scope restriction", () => {
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
        "Employees working remotely may do so 2 days per week with manager approval.",
    },
  ];
  const check = evaluateDocumentEvidence({
    docIds: citations.map((citation) => citation.docId),
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-alpha: Employees may work remotely 2 days per week with manager approval. [Source 1]",
          "- handbook-beta: Employees working remotely may do so 2 days per week with manager approval. [Source 2]",
        ].join("\n"),
        citations,
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.unsupportedClaimCount, 2);
  assert.ok(
    check.claimSupport.claims.every((claim) =>
      claim.missingAnchors.includes("substantive_contrast")
    )
  );
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
    ["Remote work is allowed up to 2 days. [Source 1]", "Remote work is allowed 2 days."],
    ["Remote work is allowed only 2 days. [Source 1]", "Remote work is allowed 2 days."],
    ["Remote work is allowed exactly 2 days. [Source 1]", "Remote work is allowed 2 days."],
    ["Remote work is limited to 2 days. [Source 1]", "Remote work is allowed 2 days."],
    ["Remote work has a limit of 2 days. [Source 1]", "Remote work is allowed 2 days."],
    ["Remote work is allowed =2 days. [Source 1]", "Remote work is allowed 2 days."],
    ["Remote work is allowed ≤2 days. [Source 1]", "Remote work is allowed 2 days."],
    ["Remote work is allowed ≥2 days. [Source 1]", "Remote work is allowed 2 days."],
    ["Remote work is allowed 2+ days. [Source 1]", "Remote work is allowed 2 days."],
    ["Remote work is allowed 2 days only. [Source 1]", "Remote work is allowed 2 days."],
    [
      "Remote work is allowed only 2 days per week. [Source 1]",
      "Remote work is allowed 2 days per week only during summer.",
    ],
    [
      "Remote work is allowed only 2 days. [Source 1]",
      "Only 2 days after onboarding, remote work is allowed.",
    ],
    [
      "Remote work is limited to 2 days, while training is allowed 3 days. [Source 1]",
      "Remote work is allowed 2 days, while training is limited to 2 days and allowed 3 days.",
    ],
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

test("numeric binding rejects the wrong clause without dropping a valid inherited subject", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text:
          "Remote work is limited to 2 days and training is allowed 3 days. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt:
              "Remote work is allowed 2 days, while training is limited to 2 days and allowed 3 days.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
  assert.equal(check.claimSupport.claims.length, 2);
  assert.equal(check.claimSupport.claims[0].supported, false);
  assert.equal(check.claimSupport.claims[1].supported, true);
});

test("numeric binding ignores a structural lead label when matching fact context", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text:
          "- Key Terms: The agreement renews every 12 months unless either party gives 30 days notice. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt:
              "The agreement renews every 12 months unless either party gives 30 days notice.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
});

test("comparison quantity qualifiers cannot hide behind comparison scaffold terms", () => {
  const citations = [
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
  ];

  for (const answer of [
    "Both allow employees to work remotely only 2 days per week. [Source 1] [Source 2]",
    "Only 2 days per week are allowed by both documents. [Source 1] [Source 2]",
    "Both allow employees to work remotely ≤2 days per week. [Source 1] [Source 2]",
    "Both allow employees to work remotely ≧2 days per week. [Source 1] [Source 2]",
    "Both allow employees to work remotely 2+ days per week. [Source 1] [Source 2]",
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: {
        ok: true,
        value: {
          text: answer,
          citations,
        },
      },
    });

    assert.equal(check.passed, false, answer);
    assert.equal(check.claimSupport.unsupportedClaimCount, 1, answer);
  }
});

test("equivalent numeric constraint surfaces normalize to the same direction", () => {
  for (const [answer, excerpt] of [
    ["Remote work is allowed only 2 days. [Source 1]", "Remote work is allowed exactly 2 days."],
    ["Remote work is allowed ≤2 days. [Source 1]", "Remote work is allowed up to 2 days."],
    ["Remote work is allowed ≧2 days. [Source 1]", "Remote work is allowed at least 2 days."],
    ["Remote work is allowed 2+ days. [Source 1]", "Remote work is allowed at least 2 days."],
  ]) {
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

    assert.equal(check.passed, true, `${answer} <- ${excerpt}`);
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
  assert.equal(result.claimSupport.claims.some((claim) => claim.heading), false);
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

test("answer finalizer retains analysis-backed Differences during a rewrite", () => {
  const result = finalizeAgentAnswer({
    answerText: [
      "Differences:",
      "- No conflicting values or conditions were detected in the retrieved evidence. [Source 1] [Source 2]",
      "Gaps or uncertainty:",
      "- A satellite stipend may be available. [Source 1]",
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
        excerpt: "Remote work requires manager approval.",
      },
      {
        rank: 2,
        docId: "doc-beta",
        fileName: "handbook-beta.pdf",
        excerpt: "Remote work requires manager approval.",
      },
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.abstained, false);
  assert.match(result.text, /^Differences\n/);
  assert.match(result.text, /No conflicting values or conditions/i);
  assert.doesNotMatch(result.text, /satellite stipend/i);
});

test("answer finalizer removes an empty Differences heading with rejected pairs", () => {
  const result = finalizeAgentAnswer({
    answerText: [
      "Summary:",
      "- Both documents require manager approval. [Source 1] [Source 2]",
      "Differences:",
      "- handbook-alpha requires manager approval. [Source 1]",
      "- handbook-beta requires manager approval. [Source 2]",
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
  });

  assert.equal(result.changed, true);
  assert.equal(result.abstained, false);
  assert.match(result.text, /^Summary\n/);
  assert.match(result.text, /Both documents require manager approval/i);
  assert.doesNotMatch(result.text, /Differences/i);
  assert.doesNotMatch(result.text, /handbook-alpha requires/i);
  assert.doesNotMatch(result.text, /handbook-beta requires/i);
});

test("answer finalizer preserves claim order across retained sections", () => {
  const result = finalizeAgentAnswer({
    answerText: [
      "Summary:",
      "- Both documents require manager approval. [Source 1] [Source 2]",
      "Differences:",
      "- handbook-alpha allows 2 remote days. [Source 1]",
      "- handbook-beta allows 3 remote days. [Source 2]",
      "Gaps or uncertainty:",
      "- A satellite stipend may be available. [Source 1]",
    ].join("\n"),
    citations: [
      {
        rank: 1,
        docId: "doc-alpha",
        fileName: "handbook-alpha.pdf",
        excerpt:
          "Remote work requires manager approval and is allowed 2 days per week.",
      },
      {
        rank: 2,
        docId: "doc-beta",
        fileName: "handbook-beta.pdf",
        excerpt:
          "Remote work requires manager approval and is allowed 3 days per week.",
      },
    ],
  });

  const summaryIndex = result.text.indexOf("Summary");
  const agreementIndex = result.text.indexOf(
    "Both documents require manager approval"
  );
  const differencesIndex = result.text.indexOf("Differences");
  const alphaIndex = result.text.indexOf("handbook-alpha allows 2 remote days");
  const betaIndex = result.text.indexOf("handbook-beta allows 3 remote days");

  assert.equal(result.changed, true);
  assert.equal(result.abstained, false);
  assert.ok(summaryIndex >= 0);
  assert.ok(summaryIndex < agreementIndex);
  assert.ok(agreementIndex < differencesIndex);
  assert.ok(differencesIndex < alphaIndex);
  assert.ok(alphaIndex < betaIndex);
  assert.doesNotMatch(result.text, /satellite stipend/i);
});

test("answer finalizer isolates repeated Differences sections by section id", () => {
  const result = finalizeAgentAnswer({
    answerText: [
      "Differences:",
      "- handbook-alpha allows 2 remote days. [Source 1]",
      "- handbook-beta allows 3 remote days. [Source 2]",
      "Differences:",
      "- handbook-alpha requires manager approval. [Source 1]",
      "- handbook-beta requires manager approval. [Source 2]",
    ].join("\n"),
    citations: [
      {
        rank: 1,
        docId: "doc-alpha",
        fileName: "handbook-alpha.pdf",
        excerpt:
          "Remote work allows 2 days per week and requires manager approval.",
      },
      {
        rank: 2,
        docId: "doc-beta",
        fileName: "handbook-beta.pdf",
        excerpt:
          "Remote work allows 3 days per week and requires manager approval.",
      },
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.abstained, false);
  assert.equal(result.text.match(/^Differences$/gm)?.length ?? 0, 1);
  assert.match(result.text, /handbook-alpha allows 2 remote days/i);
  assert.match(result.text, /handbook-beta allows 3 remote days/i);
  assert.doesNotMatch(result.text, /requires manager approval/i);
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

  const contractOrder = [
    "Contract Summary",
    "Parties",
    "Acme Corp and Beta LLC",
    "Key Terms",
    "renews every 12 months",
    "Obligations",
    "monthly support reports",
    "Deadlines",
    "Unknowns",
    "payment deadline is not specified",
  ].map((value) => result.text.indexOf(value));

  assert.ok(contractOrder.every((index) => index >= 0));
  assert.deepEqual(contractOrder, [...contractOrder].sort((a, b) => a - b));
});

test("answer finalizer preserves document comparison section headings", () => {
  const result = finalizeAgentAnswer({
    answerText: [
      "Document Comparison",
      "Common Ground",
      "- Both policies require manager approval for remote work. [Source 1] [Source 2]",
      "Differences",
      "- policy-2024 allows 2 remote days per week. [Source 1]",
      "- policy-2025 allows 3 remote days per week. [Source 2]",
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
  assert.equal(result.claimSupport.supportedClaimCount, 4);
  assert.equal(result.claimSupport.unsupportedClaimCount, 1);

  const comparisonOrder = [
    "Document Comparison",
    "Common Ground",
    "Both policies require manager approval",
    "Differences",
    "policy-2024 allows 2 remote days",
    "policy-2025 allows 3 remote days",
    "Conflicts",
    "Missing Terms",
    "No reimbursement term",
  ].map((value) => result.text.indexOf(value));

  assert.ok(comparisonOrder.every((index) => index >= 0));
  assert.deepEqual(
    comparisonOrder,
    [...comparisonOrder].sort((a, b) => a - b)
  );
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

test("numeric binding keeps parentheticals and canonical numeric spellings intact", () => {
  const cases = [
    ["Remote work is allowed 2 days. [Source 1]", "Remote work, after onboarding, is allowed 2 days."],
    ["Remote work is allowed up to 2 days. [Source 1]", "Remote work, after onboarding, is allowed up to 2 days."],
    ["The budget is $1,000. [Source 1]", "The budget is $1,000."],
    ["The budget is $1,000. [Source 1]", "The budget is $1000."],
    ["The budget is $1000. [Source 1]", "The budget is $1,000."],
    ["The threshold is 2.00 units. [Source 1]", "The threshold is 2 units."],
    ["The threshold is 2 units. [Source 1]", "The threshold is 2.00 units."],
    ["The threshold is 10.00%. [Source 1]", "The threshold is 10%."],
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed two days."],
    ["Remote work is allowed two days. [Source 1]", "Remote work is allowed 2 days."],
    ["Remote work is allowed up to 2 days. [Source 1]", "Remote work is allowed up to two days."],
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

    assert.equal(check.passed, true, `${answer} <- ${excerpt}`);
  }
});

test("numeric binding rejects inherited and predicate-local subject confusion", () => {
  const cases = [
    [
      "Remote work is allowed 2 days. [Source 1]",
      "Remote work is allowed 3 days, while allowed for training 2 days.",
    ],
    [
      "Remote work is allowed up to 2 days. [Source 1]",
      "Remote work is allowed up to 3 days, while allowed up to 2 days for training.",
    ],
    [
      "Remote work is allowed 2 days. [Source 1]",
      "Remote work is allowed 3 days, while permitted 2 days to trainees.",
    ],
    [
      "2 days are allowed for remote work. [Source 1]",
      "Remote work is allowed 3 days, while 2 days are allowed for training.",
    ],
    [
      "Remote work is limited to 2 days. [Source 1]",
      "Remote work is discussed, and safety training lasts up to 2 days.",
    ],
    [
      "Remote work is allowed 2 days. [Source 1]",
      "Remote work is allowed 3 days with 2 days advance notice.",
    ],
    [
      "Remote work is allowed only 2 days. [Source 1]",
      "Only 2 days after onboarding remote work is allowed 3 days.",
    ],
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

    assert.equal(check.passed, false, `${answer} <- ${excerpt}`);
  }
});

test("numeric binding preserves coordinated subjects without borrowing partial support", () => {
  const supported = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work is allowed up to 2 days. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt: "Remote work and training are allowed up to 2 days.",
          },
        ],
      },
    },
  });
  const unsupported = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work and training are allowed 2 days. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt:
              "Remote work is allowed 3 days, while training is allowed 2 days.",
          },
        ],
      },
    },
  });

  assert.equal(supported.passed, true);
  assert.equal(unsupported.passed, false);
});

test("numeric constraint direction is symmetric and supports signed values", () => {
  const rejectedCases = [
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed up to 2 days."],
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed at least 2 days."],
    ["Remote work is allowed just 2 days. [Source 1]", "Remote work is allowed 2 days."],
    ["The threshold is <= -2 units. [Source 1]", "The threshold is >= -2 units."],
    ["Payment is due 2 days. [Source 1]", "Payment is due within 2 days."],
  ];

  for (const [answer, excerpt] of rejectedCases) {
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

    assert.equal(check.passed, false, `${answer} <- ${excerpt}`);
  }
});

test("Differences accepts one self-contained cited cross-document contrast", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- policy-2024 allows 2 remote days, while policy-2025 allows 3 remote days. [Source 1] [Source 2]",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "policy-2024.pdf",
            excerpt: "The policy allows 2 remote days.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "policy-2025.pdf",
            excerpt: "The policy allows 3 remote days.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
  assert.equal(check.claimSupport.unsupportedClaimCount, 0);
});

test("numeric facts fail closed across independent predicates and ambiguous occurrences", () => {
  const rejectedExcerpts = [
    "Remote work is discussed and safety training lasts up to 2 days.",
    "Remote work is allowed 3 days, training is allowed 2 days.",
    "Remote work is allowed 3 days: training is allowed 2 days.",
    "Remote work is allowed 3 days / training is allowed 2 days.",
    "Remote work is allowed 3 days — training is allowed 2 days.",
    "Remote work is allowed 3 days then training is allowed 2 days.",
    "Remote work is allowed 3 days plus training is allowed 2 days.",
    "Remote work is allowed 3 days as well as training is allowed 2 days.",
    "Remote work is allowed 3 days followed by training is allowed 2 days.",
    "Remote work is allowed 3 days subject to 2 days advance notice.",
    "Remote work is allowed 3 days provided employees give 2 days advance notice.",
    "Remote work is allowed 3 days requiring 2 days advance notice.",
  ];

  for (const excerpt of rejectedExcerpts) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: "Remote work is allowed 2 days. [Source 1]",
          citations: [{ rank: 1, docId: "doc-1", excerpt }],
        },
      },
    });

    assert.equal(check.passed, false, excerpt);
  }
});

test("numeric facts support compound subjects across separate evidence clauses", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work and training are allowed 2 days. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt:
              "Remote work is allowed 2 days, while training is allowed 2 days.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
});

test("numeric fact matching ignores unrelated policy metadata numbers", () => {
  for (const excerpt of [
    "Under the 2024 policy, remote work is allowed 2 days.",
    "Policy version 3 states remote work is allowed 2 days.",
    "Section 7 allows remote work 2 days.",
    "Remote work is allowed 2 days under rule 7.",
    "Remote work is allowed 2 days (see page 7).",
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: "Remote work is allowed 2 days. [Source 1]",
          citations: [{ rank: 1, docId: "doc-1", excerpt }],
        },
      },
    });

    assert.equal(check.passed, true, excerpt);
  }
});

test("numeric metadata cannot satisfy a business quantity with the same value", () => {
  for (const excerpt of [
    "Section 7 states remote work days are allowed.",
    "Page 7 states remote work days are allowed.",
    "Policy version 7 states remote work days are allowed.",
    "Rule 7 states remote work days are allowed.",
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: {
          text: "Remote work is allowed 7 days. [Source 1]",
          citations: [{ rank: 1, docId: "doc-1", excerpt }],
        },
      },
    });

    assert.equal(check.passed, false, excerpt);
  }
});

test("numeric facts preserve inherited subjects across predicate adjuncts", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Training is allowed 3 days during onboarding. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt:
              "Training is limited to 2 days and allowed 3 days during onboarding.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, true);
});

test("numeric operators fail closed across common English and Chinese surfaces", () => {
  const cases = [
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed at or below 2 days."],
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is capped at 2 days."],
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed 2 days max."],
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed more than 2 days."],
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed under 2 days."],
    ["远程办公允许2天。[来源 1]", "远程办公最多允许2天。"],
    ["远程办公允许2天。[来源 1]", "远程办公至少允许2天。"],
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

    assert.equal(check.passed, false, `${answer} <- ${excerpt}`);
  }
});

test("numeric signs ranges and repeated values preserve occurrence identity", () => {
  const accepted = [
    ["Remote work is allowed 2-3 days. [Source 1]", "Remote work is allowed 2 to 3 days."],
    ["The floor is -2, while the ceiling is +2. [Source 1]", "The floor is -2, while the ceiling is +2."],
    ["The threshold is <= −2 units. [Source 1]", "The threshold is <= -2 units."],
    ["The threshold is <= $-2 units. [Source 1]", "The threshold is <= -$2 units."],
  ];
  const rejected = [
    ["The floor is +2, while the ceiling is -2. [Source 1]", "The floor is +2, while the ceiling is +2."],
    ["The threshold is <= −2 units. [Source 1]", "The threshold is >= −2 units."],
    ["The adjustment is -2 dollars. [Source 1]", "The adjustment is at least -2 dollars."],
    [
      "Remote work is allowed 2 days for 3 employees. [Source 1]",
      "Remote work is allowed 3 days for 2 employees.",
    ],
    [
      "Remote work is allowed up to 2 days for up to 3 employees. [Source 1]",
      "Remote work is allowed up to 3 days for up to 2 employees.",
    ],
    [
      "Remote work is allowed up to 2 days plus 2 days advance notice. [Source 1]",
      "Remote work is allowed up to 2 days plus at most 2 days advance notice.",
    ],
    ["Employees may work remotely up to 2 days. [Source 1]", "Employees may work remotely within 2 days after approval."],
  ];

  for (const [answer, excerpt] of accepted) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: { ok: true, value: { text: answer, citations: [{ rank: 1, docId: "doc-1", excerpt }] } },
    });
    assert.equal(check.passed, true, `${answer} <- ${excerpt}`);
  }

  for (const [answer, excerpt] of rejected) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: { ok: true, value: { text: answer, citations: [{ rank: 1, docId: "doc-1", excerpt }] } },
    });
    assert.equal(check.passed, false, `${answer} <- ${excerpt}`);
  }
});

test("Differences requires the same fact dimension rather than one generic token", () => {
  for (const [left, right, leftEvidence, rightEvidence] of [
    [
      "handbook-alpha allows employees remote work 2 days",
      "handbook-beta allows employees safety training 3 days",
      "Employees may perform remote work 2 days.",
      "Employees may attend safety training 3 days.",
    ],
    [
      "handbook-alpha states an annual travel budget of $500",
      "handbook-beta states an annual equipment budget of $700",
      "The annual travel budget is $500.",
      "The annual equipment budget is $700.",
    ],
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: {
        ok: true,
        value: {
          text: ["Differences:", `- ${left}. [Source 1]`, `- ${right}. [Source 2]`].join("\n"),
          citations: [
            { rank: 1, docId: "doc-alpha", fileName: "handbook-alpha.pdf", excerpt: leftEvidence },
            { rank: 2, docId: "doc-beta", fileName: "handbook-beta.pdf", excerpt: rightEvidence },
          ],
        },
      },
    });
    assert.equal(check.passed, false, `${left} <> ${right}`);
  }
});

test("Differences supports contrast wording and topic pairing independent of bullet order", () => {
  const citations = [
    {
      rank: 1,
      docId: "doc-alpha",
      fileName: "handbook-alpha.pdf",
      excerpt: "Remote work is allowed 2 days and the equipment budget is $500.",
    },
    {
      rank: 2,
      docId: "doc-beta",
      fileName: "handbook-beta.pdf",
      excerpt: "Remote work is allowed 3 days and the equipment budget is $700.",
    },
  ];

  for (const text of [
    [
      "Differences:",
      "- handbook-alpha allows 2 remote days, but handbook-beta allows 3 remote days. [Source 1] [Source 2]",
    ].join("\n"),
    [
      "Differences:",
      "- handbook-alpha allows 2 remote days. [Source 1]",
      "- handbook-alpha sets an equipment budget of $500. [Source 1]",
      "- handbook-beta allows 3 remote days. [Source 2]",
      "- handbook-beta sets an equipment budget of $700. [Source 2]",
    ].join("\n"),
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: { ok: true, value: { text, citations } },
    });
    assert.equal(check.passed, true, text);
  }
});

test("numeric occurrences bind values to generic local fact roles", () => {
  const rejected = [
    [
      "Remote work is allowed up to 2 days. [Source 1]",
      "Remote work is allowed up to 3 days, while allowed up to 2 days for training.",
    ],
    [
      "Remote work is allowed up to 2 days. [Source 1]",
      "Remote work is allowed up to 3 days, while allowed up to 2 days for safety training!",
    ],
    [
      "The policy provides 2 licenses to Alpha alongside 3 credits to Beta. [Source 1]",
      "The policy provides 2 credits to Beta alongside 3 licenses to Alpha.",
    ],
    [
      "The policy provides 2 days of remote work alongside 3 days of training. [Source 1]",
      "The policy provides 2 days of training alongside 3 days of remote work.",
    ],
  ];

  for (const [answer, excerpt] of rejected) {
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

    assert.equal(check.passed, false, `${answer} <- ${excerpt}`);
  }

  const reordered = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "The policy provides 2 licenses to Alpha alongside 3 credits to Beta. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt:
              "The policy provides 3 credits to Beta alongside 2 licenses to Alpha.",
          },
        ],
      },
    },
  });

  assert.equal(reordered.passed, true);
});

test("numeric syntax preserves approximate ranges suffix operators and number words", () => {
  const accepted = [
    ["Remote work is allowed about 2 days. [Source 1]", "Remote work is allowed approximately 2 days."],
    ["Remote work is allowed between 2 and 3 days. [Source 1]", "Remote work is allowed 2 through 3 days."],
    ["Remote work is allowed at least 2 days. [Source 1]", "Remote work is allowed 2 days or more."],
    ["Remote work is allowed at most 2 days. [Source 1]", "Remote work is allowed 2 days or fewer."],
    ["Remote work is allowed at least 2 days. [Source 1]", "Remote work is allowed 2 days at least."],
    ["Remote work is allowed at most 2 days. [Source 1]", "Remote work is allowed 2 days at most."],
    ["Remote work is allowed up to about 2 days. [Source 1]", "Remote work is allowed up to approximately 2 days."],
    ["The limit is 15 licenses. [Source 1]", "The limit is fifteen licenses."],
    ["The limit is 21 licenses. [Source 1]", "The limit is twenty-one licenses."],
    ["The allocation is 100 units. [Source 1]", "The allocation is one hundred units."],
    ["The allocation is 0.5 unit. [Source 1]", "The allocation is one-half unit."],
    ["The floor is -2 units. [Source 1]", "The floor is minus two units."],
    ["Values of $2-$3 are allowed. [Source 1]", "Values from $2 through $3 are allowed."],
    ["远程办公允许12天。[来源 1]", "远程办公允许十二天。"],
    ["远程办公允许至少2天。[来源 1]", "远程办公允许2天以上。"],
    ["远程办公允许最多2天。[来源 1]", "远程办公允许2天以内。"],
  ];
  const rejected = [
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed around 2 days."],
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed 2 days or higher."],
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed 2 days or lower."],
    ["The allocation is 1 unit. [Source 1]", "The allocation is one hundred units."],
    ["The allocation is 1 unit. [Source 1]", "The allocation is one-half unit."],
    ["The floor is 2 units. [Source 1]", "The floor is negative two units."],
    ["The threshold is exactly 2 units. [Source 1]", "The threshold is approximately equal to 2 units."],
    ["The threshold is 2 units. [Source 1]", "The threshold is ~2 units."],
    ["The threshold is 2 units. [Source 1]", "The threshold is higher than 2 units."],
    ["Values of 2-3 units are allowed. [Source 1]", "Values outside 2-3 units are allowed."],
    ["远程办公允许2天。[来源 1]", "远程办公约2天。"],
  ];

  for (const [answer, excerpt] of accepted) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: { text: answer, citations: [{ rank: 1, docId: "doc-1", excerpt }] },
      },
    });
    assert.equal(check.passed, true, `${answer} <- ${excerpt}`);
  }

  for (const [answer, excerpt] of rejected) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: { text: answer, citations: [{ rank: 1, docId: "doc-1", excerpt }] },
      },
    });
    assert.equal(check.passed, false, `${answer} <- ${excerpt}`);
  }
});

test("ISO dates remain date anchors rather than numeric ranges", () => {
  for (const [answer, excerpt, expected] of [
    [
      "Contract signed on 2024-01-10. [Source 1]",
      "Contract signed on 2024-01-10.",
      true,
    ],
    [
      "Contract signed on 2024-01-10. [Source 1]",
      "Contract signed on 2024-10-01.",
      false,
    ],
  ]) {
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

    assert.equal(check.passed, expected, `${answer} <- ${excerpt}`);
  }
});

test("numeric role matching preserves compound and respectively ordering semantics", () => {
  const compound = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Remote work, training, and travel are allowed up to 2 days. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt:
              "Remote work is allowed up to 2 days. Training is allowed up to 2 days. Travel is allowed up to 2 days.",
          },
        ],
      },
    },
  });
  const reversedRespectively = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "Alpha and Beta receive 2 and 3 licenses, respectively. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt: "Beta and Alpha receive 2 and 3 licenses, respectively.",
          },
        ],
      },
    },
  });

  assert.equal(compound.passed, true);
  assert.equal(reversedRespectively.passed, false);
});

test("Differences rejects padded scopes and supports mixed standalone and atomic contrasts", () => {
  const padded = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-alpha allows permanent salaried domestic office personnel remote work 2 days. [Source 1]",
          "- handbook-beta allows permanent salaried domestic office personnel safety training 3 days. [Source 2]",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt:
              "Permanent salaried domestic office personnel may perform remote work 2 days.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt:
              "Permanent salaried domestic office personnel may attend safety training 3 days.",
          },
        ],
      },
    },
  });
  const mixed = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-alpha allows 2 remote days, while handbook-beta allows 3 remote days. [Source 1] [Source 2]",
          "- handbook-alpha sets an equipment budget of $500. [Source 1]",
          "- handbook-beta sets an equipment budget of $700. [Source 2]",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt: "Remote work is allowed 2 days and the equipment budget is $500.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt: "Remote work is allowed 3 days and the equipment budget is $700.",
          },
        ],
      },
    },
  });

  assert.equal(padded.passed, false);
  assert.equal(mixed.passed, true);
});

test("Differences requires compatible measurement dimensions", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-alpha sets a remote work budget of $500. [Source 1]",
          "- handbook-beta sets a remote work duration of 8 hours. [Source 2]",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt: "The remote work budget is $500.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt: "The remote work duration is 8 hours.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
});

test("numeric roles preserve actor and object direction", () => {
  for (const [answer, excerpt] of [
    [
      "Alpha provides Beta 2 licenses. [Source 1]",
      "Alpha provides Beta 2 licenses.",
    ],
    [
      "Alpha receives 2 licenses from Beta. [Source 1]",
      "Alpha receives 2 licenses from Beta.",
    ],
  ]) {
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

    assert.equal(check.passed, true, `${answer} <- ${excerpt}`);
  }

  for (const [answer, excerpt] of [
    [
      "Alpha provides Beta 2 licenses. [Source 1]",
      "Beta provides Alpha 2 licenses.",
    ],
    [
      "Alpha receives 2 licenses from Beta. [Source 1]",
      "Beta receives 2 licenses from Alpha.",
    ],
  ]) {
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

    assert.equal(check.passed, false, `${answer} <- ${excerpt}`);
  }
});

test("numeric qualifiers fail closed for suffix and nested forms", () => {
  for (const [answer, excerpt] of [
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed 2 days at least."],
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed 2 days at most."],
    ["Remote work is allowed up to about 2 days. [Source 1]", "Remote work is allowed about 2 days."],
    ["远程办公允许2天。[来源 1]", "远程办公允许2天以上。"],
    ["远程办公允许2天。[来源 1]", "远程办公允许2天以内。"],
    ["远程办公允许2天。[来源 1]", "远程办公允许2天左右。"],
  ]) {
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

    assert.equal(check.passed, false, `${answer} <- ${excerpt}`);
  }
});

test("Differences does not treat one appended topic as the same fact", () => {
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-alpha allows employee data access 2 days. [Source 1]",
          "- handbook-beta allows employee data access training 3 days. [Source 2]",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt: "Employee data access is allowed 2 days.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt: "Employee data access training is allowed 3 days.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
});

test("nested markdown headings cannot escape a Differences section", () => {
  const citations = [
    {
      rank: 1,
      docId: "doc-alpha",
      fileName: "handbook-alpha.pdf",
      excerpt: "Remote work is allowed 2 days.",
    },
    {
      rank: 2,
      docId: "doc-beta",
      fileName: "handbook-beta.pdf",
      excerpt: "Safety training is allowed 3 days.",
    },
  ];
  const answerText = [
    "## Differences",
    "### Key Findings",
    "- handbook-alpha allows remote work 2 days. [Source 1]",
    "- handbook-beta allows safety training 3 days. [Source 2]",
  ].join("\n");
  const check = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: { ok: true, value: { text: answerText, citations } },
  });
  const finalized = finalizeAgentAnswer({ answerText, citations });

  assert.equal(check.passed, false);
  assert.equal(finalized.changed, true);
  assert.doesNotMatch(finalized.text, /remote work 2 days/i);
  assert.doesNotMatch(finalized.text, /safety training 3 days/i);
});

test("fact direction cannot be reversed outside a predicate whitelist", () => {
  for (const [answer, excerpt] of [
    ["Alpha supervises Beta. [Source 1]", "Beta supervises Alpha."],
    ["Alpha requires Beta approval. [Source 1]", "Beta requires Alpha approval."],
    ["Alpha reports to Beta. [Source 1]", "Beta reports to Alpha."],
    ["Alpha acquired Beta. [Source 1]", "Beta acquired Alpha."],
    ["Alpha allocates Beta 2 licenses. [Source 1]", "Beta allocates Alpha 2 licenses."],
    ["Alpha lends Beta 2 laptops. [Source 1]", "Beta lends Alpha 2 laptops."],
    [
      "Alpha requires Beta approval within 2 days. [Source 1]",
      "Beta requires Alpha approval within 2 days.",
    ],
    ["Alpha is above Beta. [Source 1]", "Beta is above Alpha."],
    ["Alpha is greater than Beta. [Source 1]", "Beta is greater than Alpha."],
    ["Alpha > Beta. [Source 1]", "Beta > Alpha."],
    [
      "Alpha requires Beta approval within 2 days and 3 signatures. [Source 1]",
      "Beta requires Alpha approval within 2 days and 3 signatures.",
    ],
    ["Alpha supervises Beta. [Source 1]", "Supervises: Beta supervises Alpha."],
    ["Alpha reports to Beta. [Source 1]", "Reports means that Beta reports to Alpha."],
    ["Alpha allocates Beta 2 licenses. [Source 1]", "Allocates: Beta allocates Alpha 2 licenses."],
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: { text: answer, citations: [{ rank: 1, docId: "doc-1", excerpt }] },
      },
    });

    assert.equal(check.passed, false, `${answer} <- ${excerpt}`);
  }
});

test("unconsumed numeric qualifiers fail closed", () => {
  for (const [answer, excerpt] of [
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed 2 days or greater."],
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed 2 days and over."],
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed 2 days or longer."],
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed 2 days approximately."],
    ["Remote work is allowed more than about 2 days. [Source 1]", "Remote work is allowed about 2 days."],
    ["Remote work is allowed within about 2 days. [Source 1]", "Remote work is allowed about 2 days."],
    ["远程办公允许2天。[来源 1]", "远程办公允许2天内。"],
    ["远程办公允许2天。[来源 1]", "远程办公允许2天起。"],
    ["远程办公允许至少约2天。[来源 1]", "远程办公允许约2天。"],
    ["Remote work is allowed up to **about 2** days. [Source 1]", "Remote work is allowed about 2 days."],
    ["Remote work is allowed more than (about 2) days. [Source 1]", "Remote work is allowed about 2 days."],
    ["Remote work is allowed 2 days. [Source 1]", "Remote work is allowed 2 days (**at least**)."],
    ["远程办公允许至少（约2天）。[来源 1]", "远程办公允许约2天。"],
    ["远程办公允许2天。[来源 1]", "远程办公允许2天（以上）。"],
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: { text: answer, citations: [{ rank: 1, docId: "doc-1", excerpt }] },
      },
    });

    assert.equal(check.passed, false, `${answer} <- ${excerpt}`);
  }
});

test("formatted and nested labels remain structural inside Differences", () => {
  const variants = [
    "**Differences**",
    "__Differences__",
    "### **Differences**",
    "Differences —",
  ];
  const citations = [
    {
      rank: 1,
      docId: "doc-alpha",
      fileName: "handbook-alpha.pdf",
      excerpt: "Differences are documented. Remote work is allowed 2 days.",
    },
    {
      rank: 2,
      docId: "doc-beta",
      fileName: "handbook-beta.pdf",
      excerpt: "Safety training is allowed 3 days.",
    },
  ];

  for (const heading of variants) {
    const answerText = [
      `${heading} [Source 1]`,
      "- handbook-alpha allows remote work 2 days. [Source 1]",
      "- handbook-beta allows safety training 3 days. [Source 2]",
    ].join("\n");
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: { ok: true, value: { text: answerText, citations } },
    });

    assert.equal(check.passed, false, heading);
  }

  for (const nestedLabel of ["- Key Findings:", "* Key Findings:"]) {
    const answerText = [
      "## Differences",
      nestedLabel,
      "- handbook-alpha allows remote work 2 days. [Source 1]",
      "- handbook-beta allows safety training 3 days. [Source 2]",
    ].join("\n");
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: { ok: true, value: { text: answerText, citations } },
    });

    assert.equal(check.passed, false, nestedLabel);
  }
});

test("numeric facts bind currency and local measurement", () => {
  const supported = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: "The equipment budget is $500. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt: "The equipment budget is 500 dollars.",
          },
        ],
      },
    },
  });

  assert.equal(supported.passed, true);

  for (const [answer, excerpt] of [
    ["The travel budget is €500. [Source 1]", "The travel budget is $500."],
    ["The travel budget is £500. [Source 1]", "The travel budget is ¥500."],
    ["The equipment budget is $500. [Source 1]", "The equipment budget covers 500 vendors."],
    ["Alpha pays Beta $500. [Source 1]", "Alpha pays Beta invoices to 500 vendors."],
    ["Remote work is allowed 1 day. [Source 1]", "A remote work day request is allowed 1 at a time."],
    ["The equipment budget is $500. [Source 1]", "The equipment budget covers 500 vendors in USD markets."],
    ["The equipment budget is $500. [Source 1]", "The equipment budget covers 500 USD vendors."],
    ["The travel budget is € 500. [Source 1]", "The travel budget is $ 500."],
    ["The travel budget is € **500**. [Source 1]", "The travel budget is £ **500**."],
    ["Remote work is allowed 1 day. [Source 1]", "A remote work request is allowed for 1 employee per day."],
    ["The rate is 5 percent. [Source 1]", "The rate covers 5 requests per percent category."],
    ["Payment is due within 2 days. [Source 1]", "Payment is due within 2 business days."],
    ["Payment is due within 2 days. [Source 1]", "Payment is due within 2 working days."],
    ["远程办公允许7天。[来源 1]", "第7章说明远程办公天数允许。"],
    ["远程办公允许7天。[来源 1]", "在第7天，远程办公申请被允许。"],
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: { text: answer, citations: [{ rank: 1, docId: "doc-1", excerpt }] },
      },
    });

    assert.equal(check.passed, false, `${answer} <- ${excerpt}`);
  }
});

test("Differences does not report equivalent converted quantities or reordered roles", () => {
  for (const [alphaClaim, betaClaim, alphaEvidence, betaEvidence] of [
    [
      "handbook-alpha allows remote work 2 days.",
      "handbook-beta allows remote work 48 hours.",
      "Remote work is allowed 2 days.",
      "Remote work is allowed 48 hours.",
    ],
    [
      "handbook-alpha requires retention for 1 year.",
      "handbook-beta requires retention for 12 months.",
      "Retention is required for 1 year.",
      "Retention is required for 12 months.",
    ],
    [
      "handbook-alpha requires training for 1 week.",
      "handbook-beta requires training for 7 days.",
      "Training is required for 1 week.",
      "Training is required for 7 days.",
    ],
    [
      "handbook-alpha requires manager approval within 2 days for employee travel.",
      "handbook-beta requires employee approval within 3 days for manager travel.",
      "Manager approval is required within 2 days for employee travel.",
      "Employee approval is required within 3 days for manager travel.",
    ],
  ]) {
    const answerText = [
      "Differences:",
      `- ${alphaClaim} [Source 1]`,
      `- ${betaClaim} [Source 2]`,
    ].join("\n");
    const citations = [
      { rank: 1, docId: "doc-alpha", fileName: "handbook-alpha.pdf", excerpt: alphaEvidence },
      { rank: 2, docId: "doc-beta", fileName: "handbook-beta.pdf", excerpt: betaEvidence },
    ];
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: { ok: true, value: { text: answerText, citations } },
    });

    assert.equal(check.passed, false, `${alphaClaim} <> ${betaClaim}`);
  }

  for (const [alphaClaim, betaClaim, alphaEvidence, betaEvidence] of [
    [
      "handbook-alpha allows remote work 2 days.",
      "handbook-beta allows remote work 2 hours.",
      "Remote work is allowed 2 days.",
      "Remote work is allowed 2 hours.",
    ],
    [
      "handbook-alpha requires retention for 1 year.",
      "handbook-beta requires retention for 1 month.",
      "Retention is required for 1 year.",
      "Retention is required for 1 month.",
    ],
  ]) {
    const answerText = [
      "Differences:",
      `- ${alphaClaim} [Source 1]`,
      `- ${betaClaim} [Source 2]`,
    ].join("\n");
    const citations = [
      { rank: 1, docId: "doc-alpha", fileName: "handbook-alpha.pdf", excerpt: alphaEvidence },
      { rank: 2, docId: "doc-beta", fileName: "handbook-beta.pdf", excerpt: betaEvidence },
    ];
    const check = evaluateDocumentEvidence({
      docIds: ["doc-alpha", "doc-beta"],
      ragResult: { ok: true, value: { text: answerText, citations } },
    });

    assert.equal(check.passed, true, `${alphaClaim} <> ${betaClaim}`);
  }
});

test("repeated numeric anchors are checked once per semantic key", () => {
  const repeatedClaim = Array.from({ length: 150 }, () => "1").join(" and ");
  const repeatedSupport = `${Array.from({ length: 149 }, () => "1").join(" and ")} and 2`;
  const startedAt = performance.now();
  const check = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: `The sequence is ${repeatedClaim}. [Source 1]`,
        citations: [{ rank: 1, docId: "doc-1", excerpt: `The sequence is ${repeatedSupport}.` }],
      },
    },
  });
  const durationMs = performance.now() - startedAt;

  assert.equal(check.passed, false);
  assert.ok(durationMs < 1_000, `numeric check took ${durationMs.toFixed(1)}ms`);

  const repeatedConstraints = Array.from(
    { length: 250 },
    () => "at least 1 item"
  ).join(" and ");
  const constraintStartedAt = performance.now();
  const constraintCheck = evaluateDocumentEvidence({
    docIds: ["doc-1"],
    ragResult: {
      ok: true,
      value: {
        text: `The sequence contains ${repeatedConstraints}. [Source 1]`,
        citations: [
          {
            rank: 1,
            docId: "doc-1",
            excerpt: `The sequence contains ${repeatedConstraints}.`,
          },
        ],
      },
    },
  });
  const constraintDurationMs = performance.now() - constraintStartedAt;

  assert.equal(constraintCheck.passed, false);
  assert.ok(
    constraintDurationMs < 1_000,
    `constraint check took ${constraintDurationMs.toFixed(1)}ms`
  );
});

test("unicode digits and curly contractions preserve semantic checks", () => {
  for (const [answer, excerpt] of [
    ["Remote work is allowed ２ days. [Source 1]", "Remote work is allowed 3 days."],
    ["Remote work is allowed １２ days. [Source 1]", "Remote work is allowed 2 days."],
    ["Remote work is allowed ٢ days. [Source 1]", "Remote work is allowed 3 days."],
    ["预算为５００元。[来源 1]", "预算为600元。"],
    ["The rate is ５０%. [Source 1]", "The rate is 60%."],
    ["Remote work is allowed. [Source 1]", "Remote work isn’t allowed."],
    ["Remote work is required. [Source 1]", "Remote work isn’t required."],
    ["Travel is allowed. [Source 1]", "Travel can’t be allowed."],
    ["Approval is required. [Source 1]", "Approval mustn’t be required."],
  ]) {
    const check = evaluateDocumentEvidence({
      docIds: ["doc-1"],
      ragResult: {
        ok: true,
        value: { text: answer, citations: [{ rank: 1, docId: "doc-1", excerpt }] },
      },
    });

    assert.equal(check.passed, false, `${answer} <- ${excerpt}`);
  }
});

test("modality support cannot cross independent evidence clauses", () => {
  for (const [answer, excerpt] of [
    [
      "Remote work is not allowed. [Source 1]",
      "Remote work is allowed and travel is not allowed.",
    ],
    [
      "Remote work is required. [Source 1]",
      "Remote work is optional and travel is required.",
    ],
  ]) {
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

    assert.equal(check.passed, false, `${answer} <- ${excerpt}`);
  }
});

test("copular relationship frames preserve actor and object direction", () => {
  for (const [answer, excerpt, expected] of [
    ["Alice is Bob's manager. [Source 1]", "Alice is Bob's manager.", true],
    ["Alice is Bob's manager. [Source 1]", "Bob is Alice's manager.", false],
    ["Alpha is the parent of Beta. [Source 1]", "Alpha is the parent of Beta.", true],
    ["Alpha is the parent of Beta. [Source 1]", "Beta is the parent of Alpha.", false],
  ]) {
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

    assert.equal(check.passed, expected, `${answer} <- ${excerpt}`);
  }
});

test("Differences supports grounded open-vocabulary value slots", () => {
  const accepted = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-alpha states the governing law is California. [Source 1]",
          "- handbook-beta states the governing law is New York. [Source 2]",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt: "The governing law is California.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt: "The governing law is New York.",
          },
        ],
      },
    },
  });
  const rejected = evaluateDocumentEvidence({
    docIds: ["doc-alpha", "doc-beta"],
    ragResult: {
      ok: true,
      value: {
        text: [
          "Differences:",
          "- handbook-alpha states the governing law is California. [Source 1]",
          "- handbook-beta states the office location is New York. [Source 2]",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            fileName: "handbook-alpha.pdf",
            excerpt: "The governing law is California.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            fileName: "handbook-beta.pdf",
            excerpt: "The office location is New York.",
          },
        ],
      },
    },
  });

  assert.equal(accepted.passed, true);
  assert.equal(rejected.passed, false);
});

test("date anchors fail closed when evidence contains a transition", () => {
  for (const [answer, excerpt, expected] of [
    ["The deadline is 2025-01-02. [Source 1]", "The deadline is 2025-01-02.", true],
    [
      "The deadline is 2025-01-02. [Source 1]",
      "The deadline was moved from 2025-01-02 to 2025-02-01.",
      false,
    ],
  ]) {
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

    assert.equal(check.passed, expected, `${answer} <- ${excerpt}`);
  }
});

test("mixed-currency ranges fail closed", () => {
  for (const [answer, excerpt, expected] of [
    ["Values of $2-$3 are allowed. [Source 1]", "Values of $2-$3 are allowed.", true],
    ["Values of $2-$3 are allowed. [Source 1]", "Values of $2-€3 are allowed.", false],
  ]) {
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

    assert.equal(check.passed, expected, `${answer} <- ${excerpt}`);
  }
});

test("numeric parent scopes cannot lend semantics across independent clauses", () => {
  for (const [answer, excerpt, expected] of [
    [
      "Remote work is allowed and the handbook contains 2 appendices. [Source 1]",
      "Remote work is prohibited, the handbook contains 2 appendices, and travel is allowed.",
      false,
    ],
    [
      "Remote work is not active for 2 days. [Source 1]",
      "Remote work is active for 2 days, and travel is not active.",
      false,
    ],
    [
      "Remote work is not active for 2 days. [Source 1]",
      "Remote work is not active for 2 days.",
      true,
    ],
  ]) {
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

    assert.equal(check.passed, expected, `${answer} <- ${excerpt}`);
  }
});

test("quoted refutations are mentions rather than supporting assertions", () => {
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
            excerpt:
              "The statement \u201cRemote work is allowed\u201d is false, and travel is allowed.",
          },
        ],
      },
    },
  });

  assert.equal(check.passed, false);
});
