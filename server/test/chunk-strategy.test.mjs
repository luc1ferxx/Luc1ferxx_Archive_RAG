import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { chunkDocument, chunkDocumentWithConfig } from "../rag/chunker.js";
import { CHUNK_STRATEGIES } from "../rag/config.js";

// RAG_CHUNK_STRATEGY and the chunker's own strategy argument: a value the
// chunker does not know is an error, not structured chunks under another name
// (a typo used to chunk as structured without a word).

const clearStrategy = () => {
  delete process.env.RAG_CHUNK_STRATEGY;
};

clearStrategy();
afterEach(clearStrategy);

const pages = [{ pageNumber: 1, text: "1 Scope\nThe policy applies to every employee. It starts in March." }];
const chunkWith = (chunkStrategy) =>
  chunkDocumentWithConfig({
    chunkOverlap: 180,
    chunkSize: 900,
    chunkStrategy,
    docId: "doc-strategy",
    fileName: "strategy.pdf",
    pages,
  });

test("a caller that names no strategy gets structured chunks", () => {
  assert.deepEqual(chunkWith(undefined), chunkWith("structured"));
  assert.deepEqual(chunkWith(null), chunkWith("structured"));
});

test("an unknown explicit strategy throws instead of chunking as structured", () => {
  for (const unknown of ["fixed", "", "Structured", "constructor", "__proto__", "toString"]) {
    assert.throws(
      () => chunkWith(unknown),
      (error) =>
        error.message.includes(JSON.stringify(unknown)) && CHUNK_STRATEGIES.every((value) => error.message.includes(value)),
      `chunkStrategy ${JSON.stringify(unknown)}`
    );
  }
});

test("the environment's strategy is validated where documents are chunked; blank is unset", () => {
  const input = { docId: "doc-strategy", fileName: "strategy.pdf", pages };

  process.env.RAG_CHUNK_STRATEGY = "fixed";
  assert.throws(() => chunkDocument(input), /RAG_CHUNK_STRATEGY must be one of structured, simple, sentence; got "fixed"/);

  for (const blank of ["", "   ", "\t"]) {
    process.env.RAG_CHUNK_STRATEGY = blank;
    assert.deepEqual(chunkDocument(input), chunkWith("structured"), JSON.stringify(blank));
  }

  process.env.RAG_CHUNK_STRATEGY = " Simple ";
  assert.deepEqual(chunkDocument(input), chunkWith("simple"));
});
