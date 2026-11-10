import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLabelingItems,
  countPossiblyTruncatedAnswers,
  LEGACY_PREDICTION_LIMIT,
  MAX_EVIDENCE_PARAGRAPHS,
  renderLabelingPage,
  toJudgeInput,
} from "../evaluation/build-answer-labeling.mjs";
import { JUDGE_VERDICTS } from "../evaluation/run-llm-judge.mjs";

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const buildCorpus = () => ({
  cases: [
    {
      answerType: "extractive",
      expectedEvidence: [{ docKey: "paper-a", pages: [2, 3] }],
      id: "q1",
      question: "Which dataset do they use?",
      referenceAnswers: ["SQuAD", "the SQuAD dataset"],
      shouldAbstain: false,
    },
    {
      answerType: "none",
      expectedEvidence: [],
      id: "q2",
      question: "Do they report latency?",
      referenceAnswers: ["Unanswerable"],
      shouldAbstain: true,
    },
    {
      answerType: "abstractive",
      expectedEvidence: [{ docKey: "paper-a", pages: [1, 9] }],
      id: "q3",
      question: "How large is the model?",
      referenceAnswer: "110M parameters",
      shouldAbstain: false,
    },
    { answerType: "boolean", expectedEvidence: [], id: "q4", question: "Refused?", referenceAnswers: ["Yes"], shouldAbstain: false },
  ],
  documents: [{ key: "paper-a", pages: ["First paragraph.", "They train on SQuAD.", "   ", "Fourth paragraph."] }],
});

const buildReport = () => ({
  config: { git: { sha: "abc123" } },
  generatedAt: "2026-11-10T00:00:00.000Z",
  reportType: "qasper-answers",
  rows: [
    { abstained: false, id: "q1", prediction: "They use SQuAD. [Source 1]" },
    { abstained: false, id: "q2", prediction: "The paper does not report latency." },
    { abstained: false, id: "q3", prediction: "</script><script>alert(1)</script> 110M" },
    { abstained: true, id: "q4", prediction: "Unanswerable" },
  ],
});

test("one item per answered question, with every reference and the annotated evidence paragraphs", () => {
  const items = buildLabelingItems({ corpus: buildCorpus(), report: buildReport() });
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  // The abstention needs no label.
  assert.deepEqual(Object.keys(byId).sort(), ["q1", "q2", "q3"]);
  assert.deepEqual(byId.q1, {
    answer: "They use SQuAD. [Source 1]",
    answerType: "extractive",
    // Page 3 is blank and is left out.
    evidence: ["They train on SQuAD."],
    id: "q1",
    question: "Which dataset do they use?",
    references: ["SQuAD", "the SQuAD dataset"],
    unanswerable: false,
  });
  assert.deepEqual([byId.q2.unanswerable, byId.q2.evidence, byId.q2.references], [true, [], ["Unanswerable"]]);
  // A single referenceAnswer is a list of one; a page the document lacks is no evidence.
  assert.deepEqual([byId.q3.references, byId.q3.evidence], [["110M parameters"], ["First paragraph."]]);
});

test("the order is random but fixed by the seed, and evidence is capped", () => {
  const corpus = {
    cases: Array.from({ length: 30 }, (_, index) => ({
      expectedEvidence: [{ docKey: "d", pages: Array.from({ length: 12 }, (_unused, page) => page + 1) }],
      id: `q${index}`,
      question: `Q${index}`,
      referenceAnswers: ["a"],
      shouldAbstain: false,
    })),
    documents: [{ key: "d", pages: Array.from({ length: 12 }, (_, page) => `paragraph ${page + 1}`) }],
  };
  const report = { rows: corpus.cases.map(({ id }) => ({ abstained: false, id, prediction: "a" })) };
  const order = (seed) => buildLabelingItems({ corpus, report, seed }).map((item) => item.id);

  assert.deepEqual(order(1), order(1));
  assert.notDeepEqual(order(1), corpus.cases.map(({ id }) => id));
  assert.notDeepEqual(order(1), order(2));
  assert.deepEqual([...order(1)].sort(), corpus.cases.map(({ id }) => id).sort());
  assert.equal(buildLabelingItems({ corpus, report })[0].evidence.length, MAX_EVIDENCE_PARAGRAPHS);
});

test("an answered question the corpus does not hold is refused", () => {
  const report = buildReport();

  report.rows.push({ abstained: false, id: "elsewhere", prediction: "x" });
  assert.throws(() => buildLabelingItems({ corpus: buildCorpus(), report }), /1 answered question\(s\) of the report are not in the corpus \(first: elsewhere\)/);
});

test("the judge input carries every reference, and none for a question annotated unanswerable", () => {
  const judgeInput = toJudgeInput(buildLabelingItems({ corpus: buildCorpus(), report: buildReport() }));
  const byId = Object.fromEntries(judgeInput.map((item) => [item.id, item]));

  assert.deepEqual(byId.q1, {
    answer: "They use SQuAD. [Source 1]",
    evidence: ["They train on SQuAD."],
    id: "q1",
    question: "Which dataset do they use?",
    referenceAnswer: ["SQuAD", "the SQuAD dataset"],
  });
  assert.equal(byId.q2.referenceAnswer, null);
});

const readEmbeddedData = (html) =>
  JSON.parse(html.match(/<script type="application\/json" id="labeling-data">([\s\S]*?)<\/script>/)[1]);

test("the page embeds the items as data no answer can break out of, and its script parses", () => {
  const items = buildLabelingItems({ corpus: buildCorpus(), report: buildReport() });
  const html = renderLabelingPage({ items, name: "sample<run>", source: { report: "report.json" } });

  // The hostile answer is still there as data, and closed no element: the page
  // has its two script elements and nothing else.
  assert.deepEqual(readEmbeddedData(html), { items, name: "sample<run>", source: { report: "report.json" } });
  assert.equal(html.match(/<\/script>/g).length, 2);
  assert.equal(html.includes("alert(1)</script>"), false);
  assert.match(html, /<title>答案标注 · sample&lt;run&gt;<\/title>/);

  // The page's own script is syntactically valid (compiled, not run: it needs a document).
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  assert.doesNotThrow(() => new Function(script));
  // Every verdict the page can write is one the judge knows.
  for (const verdict of ["correct", "partially_correct", "incorrect", "correct_abstention", "wrong_abstention"]) {
    assert.ok(JUDGE_VERDICTS.includes(verdict));
    assert.ok(script.includes(`"${verdict}"`), verdict);
  }
});

test("the command writes the page and the judge input, and names what it refuses", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "answer-labeling-"));

  try {
    const reportPath = path.join(tempRoot, "latest-run.json");
    const corpusPath = path.join(tempRoot, "corpus.json");
    const outDirectory = path.join(tempRoot, "out");
    const tool = path.join(serverDirectory, "evaluation", "build-answer-labeling.mjs");
    const run = (args) => spawnSync(process.execPath, [tool, ...args], { cwd: serverDirectory, encoding: "utf8" });

    await writeFile(reportPath, JSON.stringify(buildReport()));
    await writeFile(corpusPath, JSON.stringify(buildCorpus()));

    const built = run(["--report", reportPath, "--corpus", corpusPath, "--out", outDirectory]);

    assert.equal(built.status, 0, built.stderr);
    assert.match(built.stdout, /^3 answers to label \(1 on questions annotated unanswerable\): .*latest-run\.html/);

    const page = readEmbeddedData(await readFile(path.join(outDirectory, "latest-run.html"), "utf8"));
    const judgeInput = JSON.parse(await readFile(path.join(outDirectory, "latest-run-judge-input.json"), "utf8"));

    assert.equal(page.name, "latest-run");
    assert.deepEqual(page.source, { corpus: "corpus.json", generatedAt: "2026-11-10T00:00:00.000Z", gitSha: "abc123", report: "latest-run.json", seed: 1 });
    assert.deepEqual(judgeInput.items.map((item) => item.id), page.items.map((item) => item.id));
    assert.deepEqual(judgeInput.source, page.source);

    for (const [args, message] of [
      [["--report", reportPath], /Usage: build-answer-labeling\.mjs --report/],
      [["--report", reportPath, "--corpus", corpusPath, "--seed", "0"], /--seed must be a positive integer/],
      [["--report", reportPath, "--corpus", corpusPath, "--name", "a/b"], /--name must contain only letters/],
      [["--report", corpusPath, "--corpus", corpusPath], /is not a qasper-answers report/],
      [["--report", reportPath, "--corpus", path.join(tempRoot, "missing.json")], /missing\.json: /],
    ]) {
      const refused = run(args);

      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, message);
    }

    // An answer exactly as long as the old reports' cut is flagged, not refused.
    const cut = buildReport();

    cut.rows[0].prediction = "x".repeat(LEGACY_PREDICTION_LIMIT);
    assert.equal(countPossiblyTruncatedAnswers(buildLabelingItems({ corpus: buildCorpus(), report: cut })), 1);
    assert.equal(countPossiblyTruncatedAnswers(buildLabelingItems({ corpus: buildCorpus(), report: buildReport() })), 0);
    await writeFile(reportPath, JSON.stringify(cut));
    const warned = run(["--report", reportPath, "--corpus", corpusPath, "--out", outDirectory]);

    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stderr, /1 answer\(s\) are exactly 400 characters long: a report written before 2026-11-10 cut predictions there/);

    await writeFile(reportPath, JSON.stringify({ ...buildReport(), rows: [{ abstained: true, id: "q4", prediction: "Unanswerable" }] }));
    const nothing = run(["--report", reportPath, "--corpus", corpusPath, "--out", outDirectory]);

    assert.notEqual(nothing.status, 0);
    assert.match(nothing.stderr, /answered no question; there is nothing to label/);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});
