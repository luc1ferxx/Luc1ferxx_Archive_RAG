import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  describeChunkingConfig,
  describeEvaluationCheckout,
  describePdfConfig,
  sumTextChars,
} from "../evaluation/eval-run-config.js";

// What evaluation reports record as config.chunking, config.pdf and
// config.git (run-qasper-retrieval-eval, run-qasper-answer-eval,
// run-layout-parsing-eval).

// Every case starts from the defaults (a file runs in a process of its own).
const SETTINGS = ["PDF_PARAGRAPH_DETECTION", "PDF_PARSER", "RAG_CHUNK_OVERLAP", "RAG_CHUNK_SIZE", "RAG_CHUNK_STRATEGY"];
const clearSettings = () => {
  for (const name of SETTINGS) {
    delete process.env[name];
  }
};

clearSettings();
afterEach(clearSettings);

test("config.chunking names the settings and the chunker version the run cut chunks with", async () => {
  assert.deepEqual(await describeChunkingConfig(), {
    chunkerVersion: 2,
    overlap: 180,
    size: 900,
    strategy: "structured",
  });

  process.env.RAG_CHUNK_STRATEGY = " Sentence ";
  process.env.RAG_CHUNK_SIZE = "600";
  process.env.RAG_CHUNK_OVERLAP = "";
  assert.deepEqual(await describeChunkingConfig(), {
    chunkerVersion: 2,
    overlap: 180,
    size: 600,
    strategy: "sentence",
  });

  // A run never records a strategy it did not use.
  process.env.RAG_CHUNK_STRATEGY = "fixed";
  await assert.rejects(describeChunkingConfig(), /RAG_CHUNK_STRATEGY/);
});

test("config.pdf names the parser and paragraph detection as configured", async () => {
  assert.deepEqual(await describePdfConfig(), { paragraphDetection: true, parser: "pdfjs" });

  process.env.PDF_PARSER = "auto";
  process.env.PDF_PARAGRAPH_DETECTION = "false";
  assert.deepEqual(await describePdfConfig(), { paragraphDetection: false, parser: "auto" });
});

const SHA = "c".repeat(40);
const gitAnswering = (status) => async (args) => {
  if (args.join(" ") === "rev-parse HEAD") {
    return `${SHA}\n`;
  }

  if (args.join(" ") === "status --porcelain=v1 -z --untracked-files=all") {
    return status;
  }

  throw new Error(`Unexpected git args: ${args.join(" ")}`);
};

test("config.git records the commit, whether the work tree had changes and how many paths", async () => {
  assert.deepEqual(await describeEvaluationCheckout({ runGit: gitAnswering("") }), {
    changedPaths: 0,
    dirty: false,
    sha: SHA,
  });
  assert.deepEqual(
    await describeEvaluationCheckout({
      runGit: gitAnswering(
        [
          " M server/rag/chunker.js",
          "?? server/test/new.test.mjs",
          "R  server/rag/new-name.js",
          "server/rag/old-name.js",
          // The evaluation's own outputs do not make a checkout dirty.
          " M server/evaluation/results/latest.json",
          "?? server/evaluation/generated/qasper-dev.json",
          "",
        ].join("\0")
      ),
    }),
    { changedPaths: 4, dirty: true, sha: SHA }
  );
});

test("config.git is null when git cannot say, and the run goes on", async () => {
  assert.equal(
    await describeEvaluationCheckout({
      runGit: async () => {
        throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      },
    }),
    null
  );
  assert.equal(await describeEvaluationCheckout({ runGit: async () => "fatal: not a git repository\n" }), null);
  assert.equal(
    await describeEvaluationCheckout({
      runGit: async (args) => {
        if (args[0] === "rev-parse") {
          return `${SHA}\n`;
        }

        throw new Error("status failed");
      },
    }),
    null
  );

  // This checkout itself: a commit, or null where git is unavailable.
  const checkout = await describeEvaluationCheckout();

  assert.ok(checkout === null || (/^[0-9a-f]{40,64}$/.test(checkout.sha) && typeof checkout.dirty === "boolean"));
});

test("text sizes add up characters and read missing text as empty", () => {
  assert.equal(sumTextChars(["abc", "de", ""]), 5);
  assert.equal(sumTextChars([{ text: "abc" }, { text: null }, {}], (item) => item.text), 3);
  assert.equal(sumTextChars(undefined), 0);
});
