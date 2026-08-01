import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSyntheticDocumentId,
} from "../evaluation/synthetic-document-identity.js";

test("synthetic document ids are stable and scoped by corpus identity", () => {
  const input = {
    corpusId: "synthetic-corpus-compare-hard",
    corpusVersion: "1",
    docKey: "handbook_alpha",
  };
  const first = buildSyntheticDocumentId(input);

  assert.equal(buildSyntheticDocumentId(input), first);
  assert.match(first, /^synthetic-doc-[a-f0-9]{64}$/u);
  assert.notEqual(
    buildSyntheticDocumentId({ ...input, corpusId: "another-corpus" }),
    first
  );
  assert.notEqual(
    buildSyntheticDocumentId({ ...input, corpusVersion: "2" }),
    first
  );
  assert.notEqual(
    buildSyntheticDocumentId({ ...input, docKey: "handbook_beta" }),
    first
  );
});

test("synthetic document ids reject incomplete corpus identities", () => {
  assert.throws(
    () =>
      buildSyntheticDocumentId({
        corpusId: "synthetic-corpus-compare-hard",
        corpusVersion: "unknown",
        docKey: "handbook_alpha",
      }),
    /corpusVersion/u
  );
});
