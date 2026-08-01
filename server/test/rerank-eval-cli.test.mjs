import assert from "node:assert/strict";
import test from "node:test";
import { parseRerankEvalArgs } from "../evaluation/run-rerank-eval.mjs";

test("rerank eval CLI preserves the complete inline option value", () => {
  assert.deepEqual(
    parseRerankEvalArgs([
      "evaluation/corpus.json",
      "--cross-encoder-endpoint=https://example.test/rerank?token=a=b",
    ]),
    {
      positional: ["evaluation/corpus.json"],
      "cross-encoder-endpoint": "https://example.test/rerank?token=a=b",
    }
  );
});

test("rerank eval CLI rejects unknown, incomplete, and extra positional input", () => {
  assert.throws(
    () => parseRerankEvalArgs(["--unknown", "value"]),
    /Unknown option: --unknown/
  );
  assert.throws(
    () => parseRerankEvalArgs(["--top-k"]),
    /--top-k requires a value/
  );
  assert.throws(
    () => parseRerankEvalArgs(["first.json", "second.json"]),
    /Unexpected positional argument: second\.json/
  );
});

test("rerank eval CLI never coerces a bare numeric option into a boolean", () => {
  assert.throws(
    () => parseRerankEvalArgs(["--top-k", "--rerank-weight", "0.6"]),
    /--top-k requires a value/
  );
});
