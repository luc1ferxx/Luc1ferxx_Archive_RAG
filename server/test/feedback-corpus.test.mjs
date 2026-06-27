import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFeedbackCorpusFromRecords,
  buildFeedbackCorpusFromJsonlFile,
  buildFeedbackCorpusFromJsonlFiles,
} from "../evaluation/feedback-corpus.js";

test("feedback corpus builder converts negative feedback into synthetic eval cases", () => {
  const corpus = buildFeedbackCorpusFromRecords([
    {
      feedbackId: "feedback-helpful",
      feedbackType: "helpful",
      question: "What is the badge policy?",
      docIds: ["doc-helpful"],
      answerText: "Helpful answer.",
      citations: [],
    },
    {
      feedbackId: "feedback-incomplete",
      feedbackType: "incomplete",
      createdAt: "2026-06-07T08:00:00.000Z",
      userId: "alice",
      workspaceId: "workspace-a",
      question: "What does the remote work policy require?",
      docIds: ["doc-policy"],
      note: "The answer missed the approval condition.",
      answerText: "Remote work is allowed.",
      citations: [
        {
          docId: "doc-policy",
          fileName: "policy.pdf",
          pageNumber: 4,
          excerpt: "Remote work requires manager approval before the first remote day.",
        },
      ],
    },
    {
      feedbackId: "feedback-hallucination",
      feedbackType: "hallucination",
      question: "What is the satellite stipend?",
      docIds: ["doc-handbook"],
      note: "No such stipend exists in the handbook.",
      answerText: "The satellite stipend is 400 dollars.",
      citations: [],
    },
  ]);

  assert.equal(corpus.documents.length, 2);
  assert.equal(corpus.cases.length, 2);

  const incompleteCase = corpus.cases.find(
    (testCase) => testCase.id === "feedback_incomplete_feedback_incomplete"
  );
  assert.equal(incompleteCase.type, "qa");
  assert.equal(incompleteCase.shouldAbstain, false);
  assert.deepEqual(incompleteCase.expectedEvidence, [
    {
      docKey: "feedback_incomplete_doc_policy",
      pages: [4],
    },
  ]);
  assert.deepEqual(incompleteCase.metadata.feedback, {
    feedbackId: "feedback-incomplete",
    feedbackType: "incomplete",
    createdAt: "2026-06-07T08:00:00.000Z",
    source: "runtime",
    userId: "alice",
    workspaceId: "workspace-a",
    note: "The answer missed the approval condition.",
    originalDocIds: ["doc-policy"],
    skills: [],
    claimChecks: [],
    agentObservability: null,
  });

  const policyDocument = corpus.documents.find(
    (document) => document.key === "feedback_incomplete_doc_policy"
  );
  assert.equal(policyDocument.fileName, "policy.pdf");
  assert.equal(policyDocument.pages.length, 4);
  assert.match(
    policyDocument.pages[3],
    /Remote work requires manager approval/
  );

  const hallucinationCase = corpus.cases.find(
    (testCase) => testCase.id === "feedback_hallucination_feedback_hallucination"
  );
  assert.equal(hallucinationCase.shouldAbstain, true);
  assert.deepEqual(hallucinationCase.expectedEvidence, []);
});

test("feedback corpus builder merges seed and runtime jsonl files", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "feedback-corpus-merge-test-"));
  const seedInputPath = path.join(tempRoot, "feedback-seed.jsonl");
  const runtimeInputPath = path.join(tempRoot, "feedback.jsonl");
  const outputPath = path.join(tempRoot, "feedback-corpus.json");

  try {
    await writeFile(
      seedInputPath,
      `${JSON.stringify({
        feedbackId: "seed-feedback",
        feedbackType: "citation_error",
        source: "seed",
        question: "Where is manager approval documented?",
        docIds: ["doc-seed"],
        note: "Use the manager approval citation.",
        citations: [
          {
            docId: "doc-seed",
            fileName: "seed.pdf",
            pageNumber: 1,
            excerpt: "Remote work requires manager approval.",
          },
        ],
      })}\n`,
      "utf8"
    );
    await writeFile(
      runtimeInputPath,
      `${JSON.stringify({
        feedbackId: "runtime-feedback",
        feedbackType: "incomplete",
        question: "What is the renewal window?",
        docIds: ["doc-runtime"],
        note: "The answer missed the 30 day window.",
        citations: [
          {
            docId: "doc-runtime",
            fileName: "runtime.pdf",
            pageNumber: 2,
            excerpt: "Renewal must happen within 30 days after audit completion.",
          },
        ],
      })}\n`,
      "utf8"
    );

    const corpus = await buildFeedbackCorpusFromJsonlFiles({
      inputPaths: [seedInputPath, runtimeInputPath, path.join(tempRoot, "missing.jsonl")],
      outputPath,
    });
    const persistedCorpus = JSON.parse(await readFile(outputPath, "utf8"));

    assert.deepEqual(persistedCorpus, corpus);
    assert.equal(corpus.cases.length, 2);
    assert.deepEqual(
      corpus.cases.map((testCase) => testCase.metadata.feedback.source).sort(),
      ["runtime", "seed"]
    );
  } finally {
    await rm(tempRoot, {
      recursive: true,
      force: true,
    });
  }
});

test("feedback corpus builder reads jsonl files and writes stable corpus output", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "feedback-corpus-test-"));
  const inputPath = path.join(tempRoot, "feedback.jsonl");
  const outputPath = path.join(tempRoot, "feedback-corpus.json");

  try {
    await writeFile(
      inputPath,
      [
        JSON.stringify({
          feedbackId: "feedback-citation",
          feedbackType: "citation_error",
          question: "Where is the renewal window documented?",
          docIds: ["doc-renewal"],
          note: "The answer cited the wrong page.",
          answerText: "Renew badges every 12 months.",
          citations: [
            {
              docId: "doc-renewal",
              fileName: "renewal.pdf",
              pageNumber: 2,
              excerpt: "Renew badges every 12 months after audit completion.",
            },
          ],
        }),
        "not-json",
        "",
      ].join("\n"),
      "utf8"
    );

    const corpus = await buildFeedbackCorpusFromJsonlFile({
      inputPath,
      outputPath,
    });
    const persistedCorpus = JSON.parse(await readFile(outputPath, "utf8"));

    assert.deepEqual(persistedCorpus, corpus);
    assert.equal(persistedCorpus.cases.length, 1);
    assert.equal(persistedCorpus.cases[0].metadata.feedback.feedbackType, "citation_error");
    assert.equal(persistedCorpus.cases[0].metadata.feedback.reviewRequired, true);
  } finally {
    await rm(tempRoot, {
      recursive: true,
      force: true,
    });
  }
});
