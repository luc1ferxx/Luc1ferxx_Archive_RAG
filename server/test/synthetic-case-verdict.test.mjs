import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateSyntheticComparisonExpectation,
} from "../evaluation/synthetic-case-verdict.js";

test("no-difference expectations require a supported finalized verdict", () => {
  const result = evaluateSyntheticComparisonExpectation({
    abstained: false,
    compareExpectation: "no_difference",
    claimSupport: {
      claims: [
        {
          section: "per document",
          supported: true,
          supportedCitedDocIds: ["doc-alpha"],
          text: "Employees may work remotely 2 days per week",
        },
      ],
    },
  });

  assert.equal(result.checked, true);
  assert.equal(result.expected, "no_difference");
  assert.equal(result.actual, "unresolved");
  assert.equal(result.passed, false);
  assert.equal(result.reasonCode, "missing_supported_no_difference_verdict");
});

test("no-difference expectations reject supported substantive differences", () => {
  const result = evaluateSyntheticComparisonExpectation({
    abstained: false,
    compareExpectation: "no_difference",
    claimSupport: {
      claims: [
        {
          section: "summary",
          supported: true,
          supportedCitedDocIds: ["doc-alpha", "doc-beta"],
          text: "No evidence-backed material differences were found across the selected documents",
        },
        {
          section: "differences",
          sectionId: 4,
          supported: true,
          supportedCitedDocIds: ["doc-alpha"],
          text: "handbook-alpha allows 2 remote days",
        },
        {
          section: "differences",
          sectionId: 4,
          supported: true,
          supportedCitedDocIds: ["doc-beta"],
          text: "handbook-beta allows 3 remote days",
        },
      ],
    },
  });

  assert.equal(result.actual, "mixed");
  assert.equal(result.passed, false);
  assert.equal(result.reasonCode, "supported_substantive_difference_present");
  assert.equal(result.evidence.supportedDifferenceDocumentCount, 2);
});

test("no-difference expectations reject a supported contrast outside Differences", () => {
  const result = evaluateSyntheticComparisonExpectation({
    abstained: false,
    compareExpectation: "no_difference",
    claimSupport: {
      claims: [
        {
          section: "summary",
          supported: true,
          supportedCitedDocIds: ["doc-alpha", "doc-beta"],
          text: "No evidence-backed material differences were found across the selected documents",
        },
        {
          section: "summary",
          supported: true,
          supportedCitedDocIds: ["doc-alpha", "doc-beta"],
          text: "handbook-alpha allows 2 remote days while handbook-beta allows 3 remote days",
        },
      ],
    },
  });

  assert.equal(result.actual, "mixed");
  assert.equal(result.passed, false);
  assert.equal(result.reasonCode, "supported_substantive_difference_present");
  assert.equal(result.evidence.supportedDifferenceDocumentCount, 2);
});

test("difference expectations accept a supported cross-document difference", () => {
  const result = evaluateSyntheticComparisonExpectation({
    abstained: false,
    compareExpectation: "difference",
    claimSupport: {
      claims: [
        {
          section: "differences",
          sectionId: 4,
          supported: true,
          supportedCitedDocIds: ["doc-alpha"],
          text: "handbook-alpha allows 2 remote days",
        },
        {
          section: "differences",
          sectionId: 4,
          supported: true,
          supportedCitedDocIds: ["doc-beta"],
          text: "handbook-beta allows 3 remote days",
        },
      ],
    },
  });

  assert.equal(result.actual, "difference");
  assert.equal(result.passed, true);
  assert.equal(result.reasonCode, "ok");
  assert.equal(result.evidence.supportedDifferenceClaimCount, 2);
  assert.equal(result.evidence.supportedDifferenceDocumentCount, 2);
});

test("difference expectations reject single-document detail", () => {
  const result = evaluateSyntheticComparisonExpectation({
    abstained: false,
    compareExpectation: "difference",
    claimSupport: {
      claims: [
        {
          section: "differences",
          sectionId: 4,
          supported: true,
          supportedCitedDocIds: ["doc-alpha"],
          text: "handbook-alpha allows 2 remote days",
        },
      ],
    },
  });

  assert.equal(result.actual, "unresolved");
  assert.equal(result.passed, false);
  assert.equal(
    result.reasonCode,
    "missing_supported_cross_document_difference"
  );
});

test("abstain expectations require a finalized abstention", () => {
  const accepted = evaluateSyntheticComparisonExpectation({
    abstained: true,
    compareExpectation: "abstain",
    claimSupport: { claims: [] },
  });
  const rejected = evaluateSyntheticComparisonExpectation({
    abstained: false,
    compareExpectation: "abstain",
    claimSupport: { claims: [] },
  });

  assert.deepEqual(
    {
      actual: accepted.actual,
      passed: accepted.passed,
      reasonCode: accepted.reasonCode,
    },
    { actual: "abstain", passed: true, reasonCode: "ok" }
  );
  assert.deepEqual(
    {
      actual: rejected.actual,
      passed: rejected.passed,
      reasonCode: rejected.reasonCode,
    },
    {
      actual: "unresolved",
      passed: false,
      reasonCode: "missing_required_abstention",
    }
  );
});
