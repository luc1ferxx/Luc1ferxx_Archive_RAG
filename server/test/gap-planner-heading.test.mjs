import test from "node:test";
import assert from "node:assert/strict";

import { stripSectionHeading } from "../rag/gap-planner.js";

test("the section heading is removed when it opens the chunk, as before", () => {
  assert.equal(stripSectionHeading("Fees 2025\nThe fee is due monthly.", "Fees 2025"), "The fee is due monthly.");
  assert.equal(stripSectionHeading("fees 2025 The fee is due.", "Fees 2025"), "The fee is due.");
});

test("a heading below lines the chunker kept from earlier headings is removed as a whole line only", () => {
  const text = "Plan A | 12 seats\nPlan B | 30 seats\nFees 2025\nThe fee is due monthly.";

  assert.equal(
    stripSectionHeading(text, "Fees 2025"),
    "Plan A | 12 seats\nPlan B | 30 seats\nThe fee is due monthly."
  );
  // A body line that merely starts with the heading's words is not a heading line.
  assert.equal(
    stripSectionHeading("Intro line\nFees 2025 are due by March.", "Fees 2025"),
    "Intro line\nFees 2025 are due by March."
  );
  // Regex characters in the heading are literal.
  assert.equal(stripSectionHeading("x\nCost (USD)\nbody", "Cost (USD)"), "x\nbody");
});
