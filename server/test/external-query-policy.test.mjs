import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExternalQueryPolicy,
  EXTERNAL_QUERY_POLICY_VERSION,
} from "../rag/external-query-policy.js";

test("external query policy sanitizes private terms without exposing removed values", () => {
  const policy = buildExternalQueryPolicy({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    candidateQuery:
      "Customer Alpha ACME-X42 retrieval augmented generation Project Redwood",
    document: {
      fileName: "customer-alpha-ACME-X42.pdf",
      profile: {
        entities: ["Customer Alpha", "Project Redwood"],
        summary:
          "Customer Alpha ACME-X42 notes for Project Redwood retrieval augmented generation.",
        tags: ["retrieval", "augmented", "generation"],
      },
    },
  });

  assert.equal(policy.allowed, true);
  assert.equal(policy.policyVersion, EXTERNAL_QUERY_POLICY_VERSION);
  assert.equal(policy.sanitizedQuery, "retrieval augmented generation");
  assert.equal(policy.scopeBound, true);
  assert.equal(policy.removedTermCount > 0, true);
  assert.equal(
    policy.removedTerms.every((term) => term.value === "[redacted]"),
    true
  );

  const serializedPolicy = JSON.stringify(policy).toLowerCase();

  assert.equal(serializedPolicy.includes("customer alpha"), false);
  assert.equal(serializedPolicy.includes("acme-x42"), false);
  assert.equal(serializedPolicy.includes("redwood"), false);
  assert.equal(policy.riskFlags.includes("query_sanitized"), true);
  assert.equal(policy.riskFlags.includes("internal_identifier_detected"), true);
});

test("external query policy blocks empty sanitized external queries", () => {
  const policy = buildExternalQueryPolicy({
    candidateQuery: "Customer Alpha ACME-X42 confidential private",
    document: {
      profile: {
        entities: ["Customer Alpha", "ACME-X42"],
      },
    },
  });

  assert.equal(policy.allowed, false);
  assert.equal(policy.sanitizedQuery, "");
  assert.equal(policy.riskFlags.includes("empty_external_query"), true);
});
