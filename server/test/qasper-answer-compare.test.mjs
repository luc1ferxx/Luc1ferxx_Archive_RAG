import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapMeanInterval,
  createSeededRandom,
  pairedDeltaOfDiffs,
  pairedMeanDelta,
} from "../evaluation/paired-bootstrap.js";
import {
  compareQasperAnswerReports,
  describeAnswerRunDifferences,
  formatComparisonMarkdown,
  readAnswered,
} from "../evaluation/compare-qasper-answer-reports.mjs";
import {
  describeSampledCases,
  excludeReportCases,
  sampleQasperCases,
} from "../evaluation/run-qasper-answer-eval.mjs";
import { pairedMeanDelta as adapterPairedMeanDelta } from "../evaluation/run-query-adapter-eval.mjs";
import { qasperAnswerF1, qasperAnswerF1DashNormalized } from "../evaluation/qasper-answer-metrics.js";

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Paired bootstrap --------------------------------------------------------

test("the paired bootstrap pairs rows by id, is seeded, and is the one module the harnesses share", () => {
  const rows = [
    { f1: 1, id: "a" },
    { f1: 0, id: "b" },
    { f1: 0.5, id: "c" },
  ];
  const other = [
    { f1: 0, id: "c" },
    { f1: 0, id: "a" },
    { f1: 1, id: "z" },
  ];
  const first = pairedMeanDelta(rows, other, "f1", { iterations: 500, seed: 3 });

  assert.equal(first.cases, 2);
  assert.equal(first.delta, 0.75);
  assert.ok(first.ci95[0] <= 0.75 && first.ci95[1] >= 0.75);
  assert.deepEqual(pairedMeanDelta(rows, other, "f1", { iterations: 500, seed: 3 }), first);
  // The query-adapter eval re-exports the shared function rather than its own copy.
  assert.equal(adapterPairedMeanDelta, pairedMeanDelta);
});

test("constant differences give a point interval, and nothing to resample gives none", () => {
  assert.deepEqual(bootstrapMeanInterval([0.2, 0.2, 0.2], { iterations: 50 }), [0.2, 0.2]);
  assert.equal(bootstrapMeanInterval([], { iterations: 50 }), null);
  assert.deepEqual(pairedDeltaOfDiffs([], { iterations: 50 }), { cases: 0, ci95: null, delta: null });

  // The RNG is the mulberry32 stream every QASPER harness samples with.
  const random = createSeededRandom(7);
  const draws = [random(), random()];

  assert.deepEqual([createSeededRandom(7)(), createSeededRandom(7)()], [draws[0], draws[0]]);
  assert.notEqual(draws[0], draws[1]);
});

// Report comparison -------------------------------------------------------

const row = (id, overrides = {}) => ({ abstained: false, f1: 0, id, shouldAbstain: false, ...overrides });

// This run: today's row shape (contextEvidenceHit, citedEvidenceHit).
const THIS_RUN = {
  config: { answerRateFlags: { a: true }, chatModel: "m", seed: 1, surface: "agent" },
  rows: [
    row("q1", { answered: true, citedEvidenceHit: true, contextEvidenceHit: true, f1: 0.5 }),
    row("q2", { answered: true, citedEvidenceHit: false, contextEvidenceHit: true, f1: 1 }),
    row("q3", { abstained: true, answered: false, citedEvidenceHit: false, contextEvidenceHit: false, f1: 0 }),
    row("q4", { answered: true, citedEvidenceHit: true, contextEvidenceHit: false, f1: 0.25 }),
    row("u1", { answered: true, f1: 0, shouldAbstain: true }),
    row("u2", { abstained: true, answered: false, f1: 1, shouldAbstain: true }),
    row("only-here", { answered: true, f1: 1 }),
  ],
};
// The other run: a report from before 2026-10-04 (evidenceHit, no cited figure).
const OTHER_RUN = {
  config: { answerRateFlags: null, chatModel: "m", seed: 1, surface: "agent" },
  rows: [
    row("q1", { abstained: true, answered: false, evidenceHit: true, f1: 0 }),
    row("q2", { answered: true, evidenceHit: false, f1: 0.5 }),
    row("q3", { answered: true, evidenceHit: false, f1: 0.5 }),
    // An abstention on an answerable question can score 1 officially (one
    // annotator found it unanswerable); the answerable F1 counts it as 0.
    row("q4", { abstained: true, answered: false, evidenceHit: false, f1: 1 }),
    row("u1", { abstained: true, answered: false, f1: 1, shouldAbstain: true }),
    row("u2", { abstained: true, answered: false, f1: 1, shouldAbstain: true }),
    row("only-there", { answered: true, f1: 1 }),
  ],
};

test("a comparison pairs by id and reports this run minus the other per question subset", () => {
  const comparison = compareQasperAnswerReports(THIS_RUN, OTHER_RUN, { iterations: 200, seed: 5 });

  assert.equal(comparison.cases, 6);
  assert.equal(comparison.answerableCases, 4);
  assert.equal(comparison.unanswerableCases, 2);
  // All six, official: (0.5 + 1 + 0 + 0.25 + 0 + 1) - (0 + 0.5 + 0.5 + 1 + 1 + 1) = -1.25 over 6.
  assert.equal(comparison.answerF1.cases, 6);
  assert.equal(comparison.answerF1.delta, -0.2083);
  // Answerable only, abstention = 0: (0.5 + 1 + 0 + 0.25) - (0 + 0.5 + 0.5 + 0) = 0.75 over 4.
  assert.equal(comparison.answerableF1.cases, 4);
  assert.equal(comparison.answerableF1.delta, 0.1875);
  // Answered 3 of 4 against 2 of 4.
  assert.equal(comparison.answerRate.delta, 0.25);
  assert.deepEqual(comparison.answerableFlips, { answered: 2, abstained: 1 });
  // Unanswerable answered: 1 of 2 against 0 of 2.
  assert.equal(comparison.unanswerableAnswered.cases, 2);
  assert.equal(comparison.unanswerableAnswered.delta, 0.5);
  // The other run has no cited figure, so that comparison is empty; its
  // evidenceHit is read as the context figure.
  assert.deepEqual(comparison.citedEvidenceHit, { cases: 0, ci95: null, delta: null });
  assert.equal(comparison.contextEvidenceHit.cases, 4);
  assert.equal(comparison.contextEvidenceHit.delta, 0.25);
  // Neither fixture records a commit, which counts as "cannot be shown to match".
  assert.deepEqual(comparison.configDifferences, [
    { current: { a: true }, field: "answerRateFlags", other: null },
    { current: null, field: "git.sha", other: null },
  ]);
  assert.deepEqual([comparison.rows, comparison.otherRows], [7, 7]);

  for (const metric of ["answerF1", "answerableF1", "answerRate", "unanswerableAnswered", "contextEvidenceHit"]) {
    assert.ok(comparison[metric].ci95[0] <= comparison[metric].delta, `${metric} lower bound`);
    assert.ok(comparison[metric].ci95[1] >= comparison[metric].delta, `${metric} upper bound`);
  }

  assert.deepEqual(compareQasperAnswerReports(THIS_RUN, OTHER_RUN, { iterations: 200, seed: 5 }), comparison);
});

test("answered follows the agent surface's verdict and falls back to not abstaining", () => {
  assert.equal(readAnswered({ abstained: true, answered: true }), true);
  assert.equal(readAnswered({ abstained: false, answered: false }), false);
  assert.equal(readAnswered({ abstained: false }), true);
  assert.equal(readAnswered({ abstained: true }), false);
});

test("config differences name the changed fields: settings, flags, the prompt set, chunking and the commit", () => {
  const git = { dirty: false, sha: "abc" };
  const chunking = { chunkerVersion: 2, overlap: 180, size: 900, strategy: "structured" };

  assert.deepEqual(
    describeAnswerRunDifferences(
      { answerRateFlags: { x: 1 }, chatModel: "a", chunking, claimJudge: "off", git, surface: "rag" },
      { answerRateFlags: { x: 1 }, chatModel: "b", chunking, claimJudge: "off", git, surface: "agent" }
    ),
    [
      { current: "rag", field: "surface", other: "agent" },
      { current: "a", field: "chatModel", other: "b" },
    ]
  );
  assert.deepEqual(describeAnswerRunDifferences({ chunking, git, surface: "rag" }, { chunking, git, surface: "rag" }), []);
  // A prompt version is this project's usual A/B: the set hash tells.
  assert.deepEqual(
    describeAnswerRunDifferences(
      { chunking, git, promptTemplates: { setHash: "p1" }, surface: "rag" },
      { chunking, git, promptTemplates: { setHash: "p2" }, surface: "rag" }
    ),
    [{ current: "p1", field: "promptTemplates.setHash", other: "p2" }]
  );
  assert.deepEqual(
    describeAnswerRunDifferences(
      { chunking: { ...chunking, size: 700 }, git, surface: "rag" },
      { chunking, git, surface: "rag" }
    ),
    [{ current: 700, field: "chunking.size", other: 900 }]
  );
  // A report without a commit cannot be shown to match.
  assert.deepEqual(describeAnswerRunDifferences({ surface: "rag" }, { surface: "rag" }), [
    { current: null, field: "git.sha", other: null },
  ]);
});

test("rows the comparison cannot pair honestly are refused", () => {
  const good = { config: {}, rows: [row("a", { f1: 1 })] };

  assert.throws(
    () => compareQasperAnswerReports({ config: {}, rows: [row("a"), row("a")] }, good),
    /this report: row id a appears more than once/
  );
  assert.throws(
    () => compareQasperAnswerReports(good, { config: {}, rows: [{ abstained: false, f1: 1 }] }),
    /the other report: every row needs a string id/
  );
  assert.throws(
    () => compareQasperAnswerReports(good, { config: {}, rows: [row("a", { f1: "abc" })] }),
    /the other report: row a has no finite f1/
  );
  // No common question is not an error here: the command line refuses it.
  assert.equal(compareQasperAnswerReports(good, { config: {}, rows: [row("b", { f1: 1 })] }).cases, 0);
});

test("the comparison renders as a table with the flips and the config differences", () => {
  const comparison = compareQasperAnswerReports(THIS_RUN, OTHER_RUN, { iterations: 200, seed: 5 });
  const markdown = formatComparisonMarkdown(comparison, { against: "other.json", iterations: 200, seed: 5 }).join("\n");

  assert.match(markdown, /Paired against `other.json` \(6 questions, 4 answerable/);
  assert.match(markdown, /\| Answer rate \(answerable questions\) \| 4 \| \+0\.25 \| \[/);
  assert.match(markdown, /flipped: \+2 answered \/ −1 abstained/);
  assert.match(markdown, /differ, or cannot be shown to match, in answerRateFlags/);
  // Both reports have a row the other lacks, so the header says how many rows each had.
  assert.match(markdown, /6 questions, 4 answerable, out of 7 rows here and 7 there;/);
});

// Dash diagnostic ---------------------------------------------------------

test("f1DashNormalized folds dash variants to a hyphen while the official F1 stays as it is", () => {
  assert.equal(qasperAnswerF1("state–of–the–art", ["state-of-the-art"]), 0);
  assert.equal(qasperAnswerF1DashNormalized("state–of–the–art", ["state-of-the-art"]), 1);
  assert.equal(qasperAnswerF1DashNormalized("state-of-the-art", ["state—of—the—art"]), 1);
  assert.equal(qasperAnswerF1DashNormalized("BERT", ["BERT"]), qasperAnswerF1("BERT", ["BERT"]));
  assert.equal(qasperAnswerF1DashNormalized("Unanswerable", []), 0);
  // Full-width and small hyphens fold too; a soft hyphen is dropped.
  assert.equal(qasperAnswerF1DashNormalized("state－of﹣the－art", ["state-of-the-art"]), 1);
  assert.equal(qasperAnswerF1DashNormalized("state­of­the­art", ["stateoftheart"]), 1);
  assert.equal(qasperAnswerF1DashNormalized(null, ["x"]), 0);
});

// Exclusion and sampling --------------------------------------------------

const corpusCases = Array.from({ length: 20 }, (_, index) => ({
  docKeys: [`paper-${index % 7}`],
  id: `q${index + 1}`,
  shouldAbstain: index % 5 === 0,
}));

test("excluding a report removes its questions before sampling and records an auditable digest", () => {
  const report = {
    config: { git: { sha: "abc123" } },
    generatedAt: "2026-10-03T00:00:00.000Z",
    rows: [{ id: "q1" }, { id: "q2" }, { id: "q99" }],
  };
  const { cases, excluded } = excludeReportCases(corpusCases, report, { reportName: "other.json" });

  assert.equal(cases.length, 18);
  assert.ok(cases.every((testCase) => !["q1", "q2"].includes(testCase.id)));
  assert.deepEqual(excluded, {
    report: "other.json",
    generatedAt: "2026-10-03T00:00:00.000Z",
    gitSha: "abc123",
    // q99 is not in the corpus, so it is not counted.
    excludedIds: 2,
    excludedIdsDigest: createHash("sha256").update("q1\nq2").digest("hex"),
  });

  const sample = sampleQasperCases(cases, 5, 1);

  assert.equal(sample.length, 5);
  assert.ok(sample.every((testCase) => !["q1", "q2"].includes(testCase.id)));

  const described = describeSampledCases(sample);

  assert.equal(described.cases, 5);
  assert.equal(described.answerable + described.unanswerable, 5);
  assert.deepEqual(described.ids, sample.map((testCase) => testCase.id));
  assert.ok(described.papers >= 1 && described.papers <= 5);
});

// Command line ------------------------------------------------------------

const runNode = (args, { cwd, env }) =>
  spawnSync(process.execPath, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });

test("--list-cases prints the sample without ingesting, and --exclude-report keeps the other sample's questions out", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qasper-list-cases-"));

  try {
    const corpusPath = path.join(tempRoot, "corpus.json");
    const reportPath = path.join(tempRoot, "other.json");
    const envPath = path.join(tempRoot, "empty.env");

    await writeFile(
      corpusPath,
      JSON.stringify({
        cases: corpusCases.map((testCase) => ({ ...testCase, question: `Q ${testCase.id}`, referenceAnswers: ["x"] })),
        documents: [],
        metadata: { granularity: "paragraph" },
      })
    );
    await writeFile(envPath, "");

    const env = { DOTENV_CONFIG_PATH: envPath };
    const runner = path.join(serverDirectory, "evaluation", "run-qasper-answer-eval.mjs");
    const listed = runNode([runner, "--list-cases", "--corpus", corpusPath, "--cases", "6", "--seed", "1"], {
      cwd: serverDirectory,
      env,
    });

    assert.equal(listed.status, 0, listed.stderr);
    const lines = listed.stdout.trim().split("\n");
    assert.match(lines[0], /^6 questions \(\d+ answerable, \d+ unanswerable\) from \d+ papers; seed 1$/);
    assert.equal(lines.length, 7);
    assert.deepEqual(lines.slice(1), sampleQasperCases(corpusCases, 6, 1).map((testCase) => testCase.id));

    await writeFile(
      reportPath,
      JSON.stringify({ reportType: "qasper-answers", rows: lines.slice(1, 3).map((id) => ({ id })) })
    );
    const excluded = runNode(
      [runner, "--list-cases", "--corpus", corpusPath, "--cases", "6", "--seed", "1", "--exclude-report", reportPath],
      { cwd: serverDirectory, env }
    );

    assert.equal(excluded.status, 0, excluded.stderr);
    const excludedLines = excluded.stdout.trim().split("\n");
    assert.match(excludedLines[0], /; excluding the 2 questions of other\.json$/);
    assert.equal(excludedLines.length, 7);
    assert.ok(excludedLines.slice(1).every((id) => !lines.slice(1, 3).includes(id)));

    // Excluding every question leaves nothing to sample: an error, not an empty run.
    await writeFile(
      reportPath,
      JSON.stringify({ reportType: "qasper-answers", rows: corpusCases.map(({ id }) => ({ id })) })
    );
    const emptied = runNode(
      [runner, "--list-cases", "--corpus", corpusPath, "--exclude-report", reportPath],
      { cwd: serverDirectory, env }
    );

    assert.notEqual(emptied.status, 0);
    assert.match(emptied.stderr, /No question is left to sample after excluding the 20 questions/);

    // A file that is not a qasper-answers report is refused before anything runs.
    await writeFile(reportPath, JSON.stringify({ reportType: "synthetic", rows: [] }));
    const refused = runNode(
      [runner, "--list-cases", "--corpus", corpusPath, "--exclude-report", reportPath],
      { cwd: serverDirectory, env }
    );

    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /is not a qasper-answers report/);

    // So is a report that is not JSON, naming the file.
    await writeFile(reportPath, "{not json");
    const broken = runNode(
      [runner, "--list-cases", "--corpus", corpusPath, "--exclude-report", reportPath],
      { cwd: serverDirectory, env }
    );

    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /other\.json: /);

    // A --compare report that shares no question with the sample is refused
    // before anything is ingested.
    await writeFile(reportPath, JSON.stringify({ reportType: "qasper-answers", rows: [{ f1: 0, id: "elsewhere" }] }));
    const unpaired = runNode(
      [runner, "--list-cases", "--corpus", corpusPath, "--cases", "6", "--compare", reportPath],
      { cwd: serverDirectory, env }
    );

    // --list-cases returns first; without it the run refuses.
    assert.equal(unpaired.status, 0, unpaired.stderr);
    const unpairedRun = runNode(
      [runner, "--corpus", corpusPath, "--cases", "6", "--compare", reportPath],
      { cwd: serverDirectory, env: { ...env, OPENAI_API_KEY: "" } }
    );

    assert.notEqual(unpairedRun.status, 0);
    assert.match(unpairedRun.stderr, /shares no question id with this sample/);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("the comparison command prints the paired table for two saved reports", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qasper-compare-"));

  try {
    const thisPath = path.join(tempRoot, "this.json");
    const otherPath = path.join(tempRoot, "other.json");

    await writeFile(thisPath, JSON.stringify({ ...THIS_RUN, reportType: "qasper-answers" }));
    await writeFile(otherPath, JSON.stringify({ ...OTHER_RUN, reportType: "qasper-answers" }));

    const result = runNode(
      [
        path.join(serverDirectory, "evaluation", "compare-qasper-answer-reports.mjs"),
        thisPath,
        otherPath,
        "--iterations",
        "200",
        "--seed",
        "5",
      ],
      { cwd: serverDirectory, env: {} }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Paired against `other.json` \(6 questions, 4 answerable, out of 7 rows here and 7 there; this run minus that one, bootstrap 95% CI, 200 iterations, seed 5\)/);
    assert.match(result.stdout, /\| Answer rate \(answerable questions\) \| 4 \| \+0\.25 \|/);
    assert.match(result.stdout, /flipped: \+2 answered \/ −1 abstained/);

    const compare = (...args) =>
      runNode([path.join(serverDirectory, "evaluation", "compare-qasper-answer-reports.mjs"), ...args], {
        cwd: serverDirectory,
        env: {},
      });

    // Seed 0 is a seed; a fraction or a negative number is refused, not replaced.
    assert.match(compare(thisPath, otherPath, "--iterations", "50", "--seed", "0").stdout, /50 iterations, seed 0\)/);
    assert.match(compare(thisPath, otherPath, "--seed", "-1").stderr, /--seed must be an integer of at least 0/);
    assert.match(compare(thisPath, otherPath, "--seed", "1.5").stderr, /--seed must be an integer/);
    assert.match(compare(thisPath, otherPath, "--iterations", "0").stderr, /--iterations must be an integer of at least 1/);

    // Two reports with no question in common are refused.
    await writeFile(otherPath, JSON.stringify({ reportType: "qasper-answers", rows: [row("nowhere")] }));
    const unpaired = compare(thisPath, otherPath, "--iterations", "50");

    assert.notEqual(unpaired.status, 0);
    assert.match(unpaired.stderr, /share no question id \(7 and 1 rows\)/);

    // A report that is not JSON is named in the error.
    await writeFile(otherPath, "{broken");
    assert.match(compare(thisPath, otherPath).stderr, /other\.json: /);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});
