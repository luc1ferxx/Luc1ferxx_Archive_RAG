import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildQasperAnswerFunnel,
  classifyFunnelStage,
  formatFunnelMarkdown,
  FUNNEL_STAGES,
} from "../evaluation/qasper-answer-funnel.mjs";

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sharedConfig = () => ({
  chunking: { chunkerVersion: 2, overlap: 180, size: 900, strategy: "structured" },
  corpus: "qasper-dev.json",
  embeddingModel: "nomic-embed-text",
  retrieval: { fusion: "rrf", hybridEnabled: true, topK: 10 },
});

const answerRow = (id, fields = {}) => ({
  abstained: false,
  abstainSource: null,
  contextEvidenceHit: false,
  f1: 0,
  id,
  shouldAbstain: false,
  ...fields,
});

const buildReports = () => ({
  answers: {
    config: { ...sharedConfig(), git: { dirty: false, sha: "answers-sha" }, surface: "rag" },
    generatedAt: "2026-11-10T00:00:00.000Z",
    reportType: "qasper-answers",
    rows: [
      answerRow("q1", { abstained: true, abstainSource: "gate" }),
      answerRow("q2"),
      answerRow("q3", { abstained: true, abstainSource: "gate" }),
      answerRow("q4", { f1: 0.2 }),
      answerRow("q5", { contextEvidenceHit: true, f1: 0.8 }),
      answerRow("q6", { contextEvidenceHit: true }),
      answerRow("u1", { abstained: true, abstainSource: "gate", f1: 1, shouldAbstain: true }),
      answerRow("u2", { shouldAbstain: true }),
    ],
  },
  retrieval: {
    config: { ...sharedConfig(), git: { dirty: false, sha: "retrieval-sha" } },
    generatedAt: "2026-11-09T00:00:00.000Z",
    reportType: "qasper-retrieval",
    rows: [
      { "context@0": false, gateConfident: false, hitAtAll: false, id: "q1" },
      { "context@0": false, gateConfident: true, hitAtAll: false, id: "q2" },
      { "context@0": false, gateConfident: false, hitAtAll: true, id: "q3" },
      { "context@0": false, gateConfident: true, hitAtAll: true, id: "q4" },
      { "context@0": true, gateConfident: true, hitAtAll: true, id: "q5" },
      { "context@0": true, gateConfident: true, hitAtAll: true, id: "q6" },
      { "context@0": true, gateConfident: true, hitAtAll: true, id: "elsewhere" },
    ],
  },
});

const stageOf = (funnel, id) => funnel.answerable.stages.find((stage) => stage.id === id);

test("every answerable question lands in exactly one stage of the funnel", () => {
  const { answers, retrieval } = buildReports();
  const funnel = buildQasperAnswerFunnel(answers, retrieval);

  assert.deepEqual(funnel.answerable.stages.map((stage) => stage.id), [...FUNNEL_STAGES]);
  assert.equal(funnel.answerable.cases, 6);
  assert.equal(funnel.answerable.stages.reduce((sum, stage) => sum + stage.cases, 0), 6);
  assert.deepEqual(stageOf(funnel, "not_retrieved"), {
    answered: 1,
    answeredF1High: 0,
    answeredF1Mean: 0,
    answeredF1Zero: 1,
    cases: 2,
    id: "not_retrieved",
    refused: 1,
    refusedBySource: { gate: 1 },
    share: 0.3333,
  });
  assert.deepEqual(stageOf(funnel, "refused"), {
    answered: 0,
    answeredF1High: 0,
    answeredF1Mean: null,
    answeredF1Zero: 0,
    cases: 1,
    id: "refused",
    refused: 1,
    refusedBySource: { gate: 1 },
    share: 0.1667,
  });
  assert.equal(stageOf(funnel, "not_in_context").cases, 1);
  assert.equal(stageOf(funnel, "not_in_context").answeredF1Mean, 0.2);
  assert.deepEqual(
    [stageOf(funnel, "in_context").cases, stageOf(funnel, "in_context").answeredF1Mean, stageOf(funnel, "in_context").answeredF1Zero, stageOf(funnel, "in_context").answeredF1High],
    [2, 0.4, 1, 1]
  );
  assert.deepEqual(funnel.unanswerable, { answered: 1, cases: 2, refused: 1 });
  assert.deepEqual(funnel.answerable.inconsistent, { context: 0, gate: 0 });
  // The commit may differ between the two runs; it is listed, not refused.
  assert.deepEqual(funnel.configDifferences, [{ current: "answers-sha", field: "git.sha", other: "retrieval-sha" }]);
  assert.equal(funnel.against.answers.surface, "rag");
});

test("the high-F1 bar is an option and the stage of one question follows its two rows", () => {
  const { answers, retrieval } = buildReports();

  assert.equal(stageOf(buildQasperAnswerFunnel(answers, retrieval, { highF1: 0.9 }), "in_context").answeredF1High, 0);
  assert.equal(classifyFunnelStage(answerRow("a", { contextEvidenceHit: true }), { hitAtAll: false }), "not_retrieved");
  assert.equal(classifyFunnelStage(answerRow("a", { abstained: true }), { hitAtAll: true }), "refused");
  assert.equal(classifyFunnelStage(answerRow("a"), { hitAtAll: true }), "not_in_context");
  // A report from before the context / cited split calls the flag evidenceHit.
  assert.equal(classifyFunnelStage({ abstained: false, evidenceHit: true, id: "a" }, { hitAtAll: true }), "in_context");
});

test("a refusal by the answer model is a refusal, and no disagreement with the retrieval run's gate", () => {
  const { answers, retrieval } = buildReports();

  answers.rows[4] = answerRow("q5", { abstained: true, abstainSource: "answer_model" });
  const funnel = buildQasperAnswerFunnel(answers, retrieval);

  assert.deepEqual(stageOf(funnel, "refused").refusedBySource, { answer_model: 1, gate: 1 });
  assert.deepEqual(funnel.answerable.inconsistent, { context: 0, gate: 0 });
});

test("a run with the answer verdict on is said to be one, because its retried answers read other chunks", () => {
  const { answers, retrieval } = buildReports();

  assert.equal(buildQasperAnswerFunnel(answers, retrieval).verdictSeen, false);
  answers.rows[4] = answerRow("q5", { abstained: true, abstainSource: "answer_model" });
  assert.equal(buildQasperAnswerFunnel(answers, retrieval).verdictSeen, true);
  assert.match(formatFunnelMarkdown(buildQasperAnswerFunnel(answers, retrieval)).join("\n"), /This run had the answer verdict on: an answer written after the verdict's deeper retrieval retry/);

  const overridden = buildReports();

  overridden.answers.rows[4].verdictOverridden = true;
  assert.equal(buildQasperAnswerFunnel(overridden.answers, overridden.retrieval).verdictSeen, true);
});

test("the settings that must match are the retrieval's, the chunking's, the corpus, the embedding model and the query adapter", () => {
  for (const [change, message] of [
    [(config) => { config.chunking.size = 600; }, /chunking\.size/],
    [(config) => { config.chunking.chunkerVersion = 1; }, /chunking\.chunkerVersion/],
    [(config) => { config.retrieval.fusion = "weighted"; }, /retrieval\.fusion/],
    [(config) => { config.embeddingModel = "text-embedding-3-small"; }, /embeddingModel: "nomic-embed-text" vs "text-embedding-3-small"/],
    [(config) => { config.queryAdapter = "fingerprint-a"; }, /queryAdapter: null vs "fingerprint-a"/],
  ]) {
    const { answers, retrieval } = buildReports();

    change(retrieval.config);
    assert.throws(() => buildQasperAnswerFunnel(answers, retrieval), message);
  }
});

test("rows the two runs disagree on are counted, not corrected", () => {
  const { answers, retrieval } = buildReports();

  // The retrieval run's gate refused q4 and did not see q6's evidence in the context.
  retrieval.rows[3].gateConfident = false;
  retrieval.rows[5]["context@0"] = false;
  const funnel = buildQasperAnswerFunnel(answers, retrieval);

  assert.deepEqual(funnel.answerable.inconsistent, { context: 1, gate: 1 });
  assert.equal(stageOf(funnel, "not_in_context").cases, 1);
  assert.match(formatFunnelMarkdown(funnel).join("\n"), /disagree on 1 gate decision\(s\) and on whether the evidence was in the context of 1 question\(s\)/);
});

test("reports of other settings, another surface or another sample are refused", () => {
  const otherTopK = buildReports();

  otherTopK.retrieval.config.retrieval.topK = 6;
  assert.throws(
    () => buildQasperAnswerFunnel(otherTopK.answers, otherTopK.retrieval),
    /not run with the same settings \(retrieval\.topK: 10 vs 6\)/
  );

  const otherCorpus = buildReports();

  otherCorpus.retrieval.config.corpus = "qasper-train.json";
  assert.throws(() => buildQasperAnswerFunnel(otherCorpus.answers, otherCorpus.retrieval), /corpus: "qasper-dev\.json" vs "qasper-train\.json"/);

  // A report from before the retrieval settings were recorded cannot be shown
  // to match, whether one of the two lacks them or both do.
  const unrecorded = buildReports();

  delete unrecorded.retrieval.config.retrieval;
  assert.throws(
    () => buildQasperAnswerFunnel(unrecorded.answers, unrecorded.retrieval),
    /The retrieval report did not record its retrieval settings \(config\.retrieval\), so the two runs cannot be shown to share them/
  );
  delete unrecorded.answers.config.retrieval;
  assert.throws(
    () => buildQasperAnswerFunnel(unrecorded.answers, unrecorded.retrieval),
    /The answer and the retrieval report did not record its retrieval settings/
  );

  const agent = buildReports();

  agent.answers.config.surface = "agent";
  assert.throws(() => buildQasperAnswerFunnel(agent.answers, agent.retrieval), /rag-surface answer reports only; this one is "agent"/);

  const unpaired = buildReports();

  unpaired.retrieval.rows = unpaired.retrieval.rows.filter((row) => row.id !== "q3");
  assert.throws(
    () => buildQasperAnswerFunnel(unpaired.answers, unpaired.retrieval),
    /1 of the 6 answerable questions have no row in the retrieval report \(first: q3\)/
  );
});

test("the Markdown names every stage, the refusal sources and the unanswerable questions", () => {
  const { answers, retrieval } = buildReports();
  const markdown = formatFunnelMarkdown(buildQasperAnswerFunnel(answers, retrieval)).join("\n");

  assert.match(markdown, /^Answer funnel of 6 answerable questions/);
  assert.match(markdown, /\| Evidence not among the candidates \| 2 \| 0\.3333 \| 1 \| 1 \| 0 \| 1 \| 0 \|/);
  assert.match(markdown, /\| Evidence among the candidates, not answered \| 1 \| 0\.1667 \| 0 \| 1 \| n\/a \| n\/a \| n\/a \|/);
  assert.match(markdown, /\| Answered, evidence not in the context \| 1 \| 0\.1667 \| 1 \| 0 \| 0\.2 \| 0 \| 0 \|/);
  assert.match(markdown, /\| Answered, evidence in the context \| 2 \| 0\.3333 \| 2 \| 0 \| 0\.4 \| 1 \| 1 \|/);
  assert.match(markdown, /Refusals by source: gate 2\./);
  assert.match(markdown, /Unanswerable questions: 1 of 2 refused, 1 answered\./);
  assert.match(markdown, /The reports differ, or cannot be shown to match, in git\.sha \("answers-sha" vs "retrieval-sha"\)\./);
  assert.doesNotMatch(markdown, /disagree/);
  assert.doesNotMatch(markdown, /answer verdict/);
  // Both reports came from a clean checkout.
  assert.doesNotMatch(markdown, /checkout/);
});

test("a report from an unclean or unrecorded checkout is joined, and said to be one", () => {
  const { answers, retrieval } = buildReports();

  answers.config.git.dirty = true;
  delete retrieval.config.git;

  const funnel = buildQasperAnswerFunnel(answers, retrieval);
  const markdown = formatFunnelMarkdown(funnel).join("\n");

  assert.deepEqual([funnel.against.answers.dirty, funnel.against.retrieval.dirty, funnel.against.retrieval.gitSha], [true, null, null]);
  assert.match(markdown, /The answer report was written from a checkout with uncommitted changes; the recorded settings cannot vouch for its code\./);
  assert.match(markdown, /The retrieval report did not record whether its checkout was clean; the recorded settings cannot vouch for its code\./);
});

test("the command prints the funnel, or its JSON, and names what it refuses", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qasper-funnel-"));

  try {
    const { answers, retrieval } = buildReports();
    const answersPath = path.join(tempRoot, "answers.json");
    const retrievalPath = path.join(tempRoot, "retrieval.json");
    const tool = path.join(serverDirectory, "evaluation", "qasper-answer-funnel.mjs");
    const run = (args) => spawnSync(process.execPath, [tool, ...args], { cwd: serverDirectory, encoding: "utf8" });

    await writeFile(answersPath, JSON.stringify(answers));
    await writeFile(retrievalPath, JSON.stringify(retrieval));

    const printed = run([answersPath, retrievalPath]);

    assert.equal(printed.status, 0, printed.stderr);
    assert.match(printed.stdout, /^Answer funnel of 6 answerable questions/);

    const json = run([answersPath, retrievalPath, "--json", "--high-f1", "0.9"]);

    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).highF1, 0.9);
    assert.equal(JSON.parse(json.stdout).answerable.cases, 6);

    for (const args of [[answersPath, retrievalPath, "--high-f1"], [answersPath, retrievalPath, "--high-f1", "--json"]]) {
      const missing = run(args);

      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /--high-f1 takes a number in \(0, 1\]/);
    }

    const badBar = run([answersPath, retrievalPath, "--high-f1", "2"]);

    assert.notEqual(badBar.status, 0);
    assert.match(badBar.stderr, /--high-f1 must be a number in \(0, 1\]/);

    const missing = run([answersPath]);

    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Usage: qasper-answer-funnel\.mjs/);

    // The two reports the wrong way round: the second is not a retrieval report.
    const swapped = run([answersPath, answersPath]);

    assert.notEqual(swapped.status, 0);
    assert.match(swapped.stderr, /is not a qasper-retrieval report/);

    await writeFile(retrievalPath, "{not json");
    const broken = run([answersPath, retrievalPath]);

    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /retrieval\.json: /);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});
