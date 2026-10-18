import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  formatDoclingRoutingMarkdown,
  parseDoclingRoutingCheckArguments,
  tokenDice,
  tokenRecall,
} from "../evaluation/run-docling-routing-check.mjs";

test("routing check arguments: arms, counts and the OCR pair are checked", () => {
  const options = parseDoclingRoutingCheckArguments(["--papers", "5", "--arms", "docling:0:1, auto:4:2, auto:0:1:0"]);

  assert.equal(options.papers, 5);
  assert.deepEqual(
    options.arms.map(({ batchSize, concurrency, mergeGapPages, parser }) => [parser, batchSize, concurrency, mergeGapPages]),
    [["docling", 0, 1, 2], ["auto", 4, 2, 2], ["auto", 0, 1, 0]]
  );
  assert.equal(options.arms[0].label, "docling batch=0 concurrency=1");
  assert.equal(options.arms[1].label, "auto batch=4 concurrency=2 gap=2");
  assert.equal(options.arms[2].label, "auto batch=0 concurrency=1 gap=0");
  assert.throws(() => parseDoclingRoutingCheckArguments(["--arms", "auto:0:1:-1"]), /--arms entries/);
  assert.equal(parseDoclingRoutingCheckArguments(["--ocr-pdf", "a.pdf", "--ocr-reference", "b.pdf"]).ocrPdf, path.resolve("a.pdf"));
  assert.throws(() => parseDoclingRoutingCheckArguments(["--arms", "pdfjs:0:1"]), /--arms entries/);
  assert.throws(() => parseDoclingRoutingCheckArguments(["--arms", "auto:0:0"]), /--arms entries/);
  assert.throws(() => parseDoclingRoutingCheckArguments(["--papers", "-1"]), /--papers/);
  assert.throws(() => parseDoclingRoutingCheckArguments(["--ocr-pdf", "a.pdf"]), /go together/);
  assert.throws(() => parseDoclingRoutingCheckArguments(["--bogus", "1"]), /Unknown or incomplete/);
});

test("token scores: Dice ignores order and case, recall counts the reference's words", () => {
  assert.equal(tokenDice("Model F1 84.2", "f1 model 84 2"), 1);
  assert.equal(tokenDice("", ""), 1);
  assert.equal(tokenDice("a b", "c d"), 0);
  assert.equal(tokenDice("a b c d", "a b"), 2 / 3);
  assert.equal(tokenRecall("the cat sat", "the cat"), 1);
  assert.equal(tokenRecall("the", "the the cat sat"), 0.25);
  assert.equal(tokenRecall("anything", ""), 1);
});

test("the markdown report lists numbering, arms and OCR pages without page text", () => {
  const markdown = formatDoclingRoutingMarkdown({
    arms: [
      { errors: [], label: "docling batch=0 concurrency=1", pages: 14, totalMs: 16100 },
      { agreement: { comparedPages: 5, identicalPages: 4, minDice: 0.962 }, errors: [], label: "auto batch=0 concurrency=2", pages: 14, routing: { doclingPages: 5 }, totalMs: 12200 },
    ],
    doclingServe: "http://127.0.0.1:5010",
    numbering: [{ numbering: "original", pageKeys: [2, 3], paper: "1604.00400", status: 200 }],
    ocr: { pages: [{ pageNumber: 1, parser: "docling", reasons: ["image_without_text"], recall: 0.97, route: "ocr" }] },
    papers: 2,
  });

  assert.match(markdown, /page keys \[2, 3\] -> original/);
  assert.match(markdown, /\| auto batch=0 concurrency=2 \| 12\.2 \| 14 \| 0 \| 5 \| 4\/5 \| 0\.962 \|/);
  assert.match(markdown, /page 1: route ocr \(image_without_text\), parser docling, token recall 0\.97/);
});
