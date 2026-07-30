import test from "node:test";
import assert from "node:assert/strict";

import {
  markHistoricalQualityEvidence,
} from "../evaluation/quality-result-reader.js";

test("legacy quality payloads declare that they are not current-commit evidence", () => {
  const payload = markHistoricalQualityEvidence({
    status: "pass",
  });

  assert.deepEqual(payload, {
    authoritativeForCurrentCommit: false,
    evidenceScope: "historical",
    status: "pass",
    verification: {
      currentCommitVerified: false,
      scope: "historical",
    },
  });
});
