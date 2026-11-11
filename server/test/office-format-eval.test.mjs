// The Office format evaluation's pure parts (evaluation/office-format-eval.js)
// and the testable parts of its corpus builder and runner: the synthetic
// workbooks and decks, the QASPER documents, the questions and gold answers,
// the AppleScript, the answer and evidence checks, and the paired summaries.
// The corpus builder drives Office through AppleScript and is not run here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { planOfficeFormatCorpus, writeSheetWorkbook } from "../evaluation/build-office-format-corpus.mjs";
import {
  CORPUS_METRICS,
  SHEET_DOMAINS,
  SHEET_NUMBER_FORMATS,
  answerMatchesGold,
  appleScriptString,
  buildDeckQuestions,
  buildDeckSpec,
  buildSheetQuestions,
  buildSheetSpec,
  buildWordQuestions,
  deckAppleScript,
  evidenceInContexts,
  extractIsoDates,
  extractNumbers,
  formatCellDisplay,
  formatOfficeFormatMarkdown,
  isTextEvidenceQasperQuestion,
  isoDateToExcelSerial,
  pairedArmDelta,
  qasperPaperToBlocks,
  scoreArmAnswer,
  selectQasperPapers,
  sheetRoundTripAppleScript,
  sheetSpecToCells,
  summarizeOfficeFormatRows,
  wordRoundTripAppleScript,
} from "../evaluation/office-format-eval.js";
import { createSeededRandom } from "../evaluation/paired-bootstrap.js";
import { armsForQuestion } from "../evaluation/run-office-format-eval.mjs";
import { loadDocumentPages } from "../rag/document-loader.js";

const budgetDomain = SHEET_DOMAINS.find((domain) => domain.id === "budget");

test("cells are displayed as Excel shows them under the column's number format", () => {
  assert.equal(formatCellDisplay(47250, "money"), "47,250.00");
  assert.equal(formatCellDisplay(-2250.5, "money"), "-2,250.50");
  assert.equal(formatCellDisplay(2.5, "money"), "2.50");
  assert.equal(formatCellDisplay(12000, "count"), "12,000");
  assert.equal(formatCellDisplay(4521, "number"), "4521");
  assert.equal(formatCellDisplay(0.125, "percent"), "12.5%");
  assert.equal(formatCellDisplay(-0.034, "percent"), "-3.4%");
  assert.equal(formatCellDisplay("Lyon", "choice"), "Lyon");
  assert.deepEqual(SHEET_NUMBER_FORMATS, {
    count: "#,##0",
    date: "yyyy-mm-dd",
    money: "#,##0.00",
    number: "0",
    percent: "0.0%",
  });
});

test("ISO dates become Excel 1900-system serials", () => {
  assert.equal(isoDateToExcelSerial("2026-01-01"), 46023);
  assert.equal(isoDateToExcelSerial("1900-03-01"), 61);
});

test("a sheet spec is deterministic, its keys unique, its displays formatted", () => {
  const first = buildSheetSpec({ domain: budgetDomain, id: "sheet-01-budget", random: createSeededRandom(7) });
  const again = buildSheetSpec({ domain: budgetDomain, id: "sheet-01-budget", random: createSeededRandom(7) });
  const other = buildSheetSpec({ domain: budgetDomain, id: "sheet-01-budget", random: createSeededRandom(8) });

  assert.deepEqual(first, again);
  assert.notDeepEqual(first, other);
  assert.ok(first.rows.length >= budgetDomain.rows[0] && first.rows.length <= budgetDomain.rows[1]);
  assert.equal(new Set(first.rows.map((row) => row.key)).size, first.rows.length);
  assert.deepEqual(
    first.columns.map((column) => column.header),
    ["Budget", "Spent", "Headcount", "Review date", "Owner"]
  );

  for (const row of first.rows) {
    row.cells.forEach((cell, index) => {
      const { kind } = first.columns[index];

      assert.equal(cell.display, kind === "date" ? cell.value : formatCellDisplay(cell.value, kind));
    });
  }

  // Owners are distinct people.
  const owners = first.rows.map((row) => row.cells[4].value);

  assert.equal(new Set(owners).size, owners.length);
});

test("a staff sheet never names an employee as someone's manager", () => {
  const staff = SHEET_DOMAINS.find((domain) => domain.id === "staff");
  const spec = buildSheetSpec({ domain: staff, id: "sheet-03-staff", random: createSeededRandom(3) });
  const employees = new Set(spec.rows.map((row) => row.key));

  for (const row of spec.rows) {
    assert.equal(employees.has(row.cells[3].value), false);
  }
});

test("sheet questions ask distinct rows and carry the displayed value as the gold answer", () => {
  const spec = buildSheetSpec({ domain: budgetDomain, id: "sheet-01-budget", random: createSeededRandom(11) });
  const questions = buildSheetQuestions({ count: 6, random: createSeededRandom(12), spec });

  assert.equal(questions.length, 6);
  assert.equal(new Set(questions.map((question) => question.evidence.key)).size, 6);

  for (const question of questions) {
    const row = spec.rows.find((entry) => entry.key === question.evidence.key);
    const columnIndex = spec.columns.findIndex((column) => question.question.includes(`the ${column.header} for`));
    const column = spec.columns[columnIndex];

    assert.ok(row && column, question.question);
    assert.equal(question.gold.value, row.cells[columnIndex].display);
    assert.equal(question.evidence.value, row.cells[columnIndex].display);
    assert.equal(question.question, `${column.kind === "person" ? "Who" : "What"} is the ${column.header} for ${row.key}?`);
    assert.equal(question.gold.kind, column.kind === "date" ? "date" : column.kind === "person" ? "text" : "number");
    assert.equal(question.corpus, "sheet");
    assert.equal(question.docId, spec.id);
  }
});

test("a sheet's cells carry numbers with their formats and dates as serials", () => {
  const spec = {
    columns: [
      { header: "Spent", kind: "money" },
      { header: "Review date", kind: "date" },
      { header: "Owner", kind: "person" },
    ],
    keyHeader: "Department",
    rows: [{ cells: [{ display: "47,250.00", value: 47250 }, { display: "2026-01-01", value: "2026-01-01" }, { display: "Uma Xu", value: "Uma Xu" }], key: "Marketing" }],
  };

  assert.deepEqual(sheetSpecToCells(spec), [
    [
      { type: "string", value: "Department" },
      { type: "string", value: "Spent" },
      { type: "string", value: "Review date" },
      { type: "string", value: "Owner" },
    ],
    [
      { type: "string", value: "Marketing" },
      { format: "#,##0.00", type: "number", value: 47250 },
      { format: "yyyy-mm-dd", type: "number", value: 46023 },
      { type: "string", value: "Uma Xu" },
    ],
  ]);
});

test("a workbook written for Excel reads back with every gold value as its cell's text", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "office-format-eval-"));

  t.after(() => rm(directory, { force: true, recursive: true }));

  for (const domain of SHEET_DOMAINS) {
    const random = createSeededRandom(21);
    const spec = buildSheetSpec({ domain, id: `sheet-${domain.id}`, random });
    const questions = buildSheetQuestions({ count: 6, random, spec });
    const filePath = path.join(directory, `${domain.id}.xlsx`);

    await writeFile(filePath, writeSheetWorkbook(spec));

    const { pages } = await loadDocumentPages(filePath);

    assert.equal(pages.length, 1);
    assert.equal(pages[0].locationLabel, spec.sheetName);

    for (const question of questions) {
      const header = spec.columns.find((column) => question.question.includes(`the ${column.header} for`)).header;

      assert.ok(
        pages[0].text.includes(`${spec.keyHeader}: ${question.evidence.key}; `) &&
          pages[0].text.includes(`${header}: ${question.gold.value}`),
        `${domain.id}: ${question.question} -> ${question.gold.value}`
      );
    }
  }
});

test("a deck has four content slides of three facts, two speaker notes, and one answer per question", () => {
  const spec = buildDeckSpec({ id: "deck-01", random: createSeededRandom(5) });
  const again = buildDeckSpec({ id: "deck-01", random: createSeededRandom(5) });

  assert.deepEqual(spec, again);
  assert.equal(spec.slides.length, 4);
  assert.ok(spec.slides.every((slide) => slide.bullets.length === 3));
  assert.equal(spec.slides.filter((slide) => slide.note).length, 2);

  const statements = spec.slides.flatMap((slide) => [...slide.bullets, ...(slide.note ? [slide.note] : [])]);

  assert.equal(new Set(statements.map((fact) => fact.statement)).size, statements.length);
  assert.equal(new Set(statements.map((fact) => fact.question)).size, statements.length);
  // Every body template once per deck.
  assert.equal(new Set(spec.slides.flatMap((slide) => slide.bullets.map((fact) => fact.template))).size, 12);

  const questions = buildDeckQuestions({ random: createSeededRandom(6), spec });

  assert.equal(questions.filter((question) => question.group === "body").length, 4);
  assert.equal(questions.filter((question) => question.group === "notes").length, 2);

  for (const question of questions) {
    const fact = statements.find((entry) => entry.statement === question.evidence.statement);

    assert.ok(fact);
    assert.equal(question.question, fact.question);
    assert.deepEqual(question.gold, fact.gold);
    assert.equal(question.group, fact.kind);
    // The gold value is written in the fact itself.
    assert.ok(fact.statement.includes(fact.gold.value.replace(/ (percent|minutes|years|out of 5)$/, "")), fact.statement);
  }
});

const qasperFixture = {
  "1901.00001": {
    abstract: "We study things.",
    full_text: [
      { paragraphs: ["Intro text one.", "  "], section_name: "Introduction" },
      { paragraphs: ["The encoder has six layers."], section_name: "Model ::: Encoder" },
    ],
    qas: [
      {
        answers: [{ answer: { evidence: ["The encoder has six layers."], extractive_spans: ["six layers"], unanswerable: false } }],
        question: "How many layers does the encoder have?",
        question_id: "q1",
      },
      {
        answers: [{ answer: { evidence: ["FLOAT SELECTED: Table 1"], extractive_spans: ["0.91"], unanswerable: false } }],
        question: "What is the F1?",
        question_id: "q2",
      },
      { answers: [{ answer: { unanswerable: true } }], question: "Is it open source?", question_id: "q3" },
      {
        answers: [{ answer: { evidence: ["We study things."], free_form_answer: "things", unanswerable: false } }],
        question: "What do they study?",
        question_id: "q4",
      },
    ],
    title: "A   Paper",
  },
  "1901.00002": { abstract: "", full_text: [], qas: [], title: "Empty" },
};

test("QASPER papers become Word blocks and their text-evidence questions", () => {
  const paper = qasperFixture["1901.00001"];

  assert.equal(isTextEvidenceQasperQuestion(paper.qas[0]), true);
  assert.equal(isTextEvidenceQasperQuestion(paper.qas[1]), false);
  assert.equal(isTextEvidenceQasperQuestion(paper.qas[2]), false);
  assert.deepEqual(qasperPaperToBlocks(paper), [
    { text: "A Paper" },
    { heading: 1, text: "Abstract" },
    { text: "We study things." },
    { heading: 1, text: "Introduction" },
    { text: "Intro text one." },
    { heading: 2, text: "Encoder" },
    { text: "The encoder has six layers." },
  ]);
  assert.deepEqual(buildWordQuestions({ paper, paperId: "1901.00001" }), [
    {
      corpus: "word",
      docId: "1901.00001",
      gold: { kind: "qasper", references: ["six layers"], spans: ["six layers"] },
      group: "text",
      id: "q1",
      question: "How many layers does the encoder have?",
    },
    {
      corpus: "word",
      docId: "1901.00001",
      gold: { kind: "qasper", references: ["things"], spans: [] },
      group: "text",
      id: "q4",
      question: "What do they study?",
    },
  ]);
  assert.deepEqual(selectQasperPapers(qasperFixture, { count: 5, minQuestions: 2 }), ["1901.00001"]);
  assert.deepEqual(selectQasperPapers(qasperFixture, { count: 5, minQuestions: 3 }), []);
});

test("the corpus plan is deterministic and spreads sheets over every domain", () => {
  const options = { corpora: ["sheet", "deck", "word"], decks: 2, papers: 5, qasper: qasperFixture, seed: 1, sheetQuestions: 6, sheets: 6 };
  const plan = planOfficeFormatCorpus(options);

  assert.deepEqual(plan, planOfficeFormatCorpus(options));
  assert.deepEqual(
    plan.map((document) => document.id),
    [
      "sheet-01-budget",
      "sheet-02-inventory",
      "sheet-03-staff",
      "sheet-04-sales",
      "sheet-05-projects",
      "sheet-06-vendors",
      "deck-01",
      "deck-02",
    ]
  );
  assert.ok(plan.filter((document) => document.corpus === "sheet").every((document) => document.questions.length === 6));
  assert.ok(plan.filter((document) => document.corpus === "deck").every((document) => document.questions.length === 6));

  // A paper needs three text-evidence questions; 1901.00001 has two.
  const third = {
    answers: [{ answer: { evidence: ["Intro text one."], extractive_spans: ["Intro text one"], unanswerable: false } }],
    question: "What does the introduction say?",
    question_id: "q5",
  };
  const richer = { ...qasperFixture["1901.00001"], qas: [...qasperFixture["1901.00001"].qas, third] };
  const words = planOfficeFormatCorpus({ ...options, corpora: ["word"], qasper: { ...qasperFixture, "1901.00009": richer } });

  assert.deepEqual(
    words.map((document) => [document.id, document.questions.map((question) => question.id)]),
    [["1901.00009", ["q1", "q4", "q5"]]]
  );
  assert.equal(words[0].blocks[0].text, "A Paper");
});

test("AppleScript strings are quoted, and the scripts name both outputs", () => {
  assert.equal(appleScriptString('He said "hi" \\ bye'), '"He said \\"hi\\" \\\\ bye"');

  const spec = buildDeckSpec({ id: "deck-01", random: createSeededRandom(5) });
  const script = deckAppleScript({ pdfPath: "/w/deck-01.pdf", pptxPath: "/w/deck-01.pptx", spec });

  assert.equal((script.match(/notes page of s/g) ?? []).length, 2);
  assert.equal((script.match(/slide layout text slide/g) ?? []).length, 4);
  assert.match(script, /save pres in \(POSIX file "\/w\/deck-01.pptx"\) as save as Open XML presentation/);
  assert.match(script, /save pres in \(POSIX file "\/w\/deck-01.pdf"\) as save as PDF/);
  assert.ok(script.includes(appleScriptString(spec.slides[0].bullets[0].statement)));
  assert.match(
    wordRoundTripAppleScript({ docxPath: "/w/a.docx", pdfPath: "/w/a.pdf", sourcePath: "/w/a-source.docx" }),
    /open \(POSIX file "\/w\/a-source.docx"\)[\s\S]*file name "\/w\/a.docx" file format format document[\s\S]*file name "\/w\/a.pdf" file format format PDF/
  );

  const sheetScript = sheetRoundTripAppleScript({ pdfPath: "/w/s.pdf", sourcePath: "/w/s-source.xlsx", xlsxPath: "/w/s.xlsx" });

  assert.match(sheetScript, /autofit \(entire column of \(used range of ws\)\)/);
  assert.match(sheetScript, /set print title rows of ps to "\$1:\$1"/);
  assert.match(sheetScript, /set fit to pages wide of ps to 1/);
});

test("numbers and dates are read out of answers", () => {
  assert.deepEqual(extractNumbers("Spent was 47,250.00, a deficit of -2,250."), [47250, -2250]);
  assert.deepEqual(extractNumbers("12.5% growth"), [12.5]);
  assert.deepEqual(extractIsoDates("on 2026-09-14"), ["2026-09-14"]);
  assert.deepEqual(extractIsoDates("on September 14, 2026"), ["2026-09-14"]);
  assert.deepEqual(extractIsoDates("on 4th March 2027"), ["2027-03-04"]);
  assert.deepEqual(extractIsoDates("in Spring 2026"), []);
});

test("an answer gives the gold value by number, by date or by whole words, never when abstained", () => {
  const money = { kind: "number", value: "47,250.00" };

  assert.equal(answerMatchesGold({ text: "The Spent for Marketing is 47,250.00 [Source 1]." }, money), true);
  assert.equal(answerMatchesGold({ text: "It spent 47250." }, money), true);
  assert.equal(answerMatchesGold({ text: "It spent 47,520.00." }, money), false);
  assert.equal(answerMatchesGold({ abstained: true, text: "47,250.00" }, money), false);
  assert.equal(answerMatchesGold({ text: "" }, money), false);
  assert.equal(answerMatchesGold({ text: "Growth was 12.5 percent." }, { kind: "number", value: "12.5%" }), true);
  assert.equal(answerMatchesGold({ text: "Remaining: -2,250.00" }, { kind: "number", value: "-2,250.00" }), true);
  assert.equal(answerMatchesGold({ text: "Remaining: 2,250.00" }, { kind: "number", value: "-2,250.00" }), false);
  assert.equal(answerMatchesGold({ text: "Rated 4.3 out of 5." }, { kind: "number", value: "4.3 out of 5" }), true);
  assert.equal(answerMatchesGold({ text: "Reviewed on September 14, 2026." }, { kind: "date", value: "2026-09-14" }), true);
  assert.equal(answerMatchesGold({ text: "Reviewed on 2026-09-15." }, { kind: "date", value: "2026-09-14" }), false);
  assert.equal(answerMatchesGold({ text: "Priya Rossi leads it." }, { kind: "text", value: "Priya Rossi" }), true);
  assert.equal(answerMatchesGold({ text: "Priya leads it." }, { kind: "text", value: "Priya Rossi" }), false);
  assert.equal(answerMatchesGold({ text: "The office is in Lyons." }, { kind: "text", value: "Lyon" }), false);
  assert.equal(answerMatchesGold({ text: "It moves to Station Road in May." }, { kind: "text", value: "Station Road" }), true);
});

test("evidence is in the context when one chunk holds the row's key and value, or the fact", () => {
  const sheetQuestion = { corpus: "sheet", evidence: { key: "Marketing", value: "47,250.00" } };

  assert.equal(evidenceInContexts(["Department: Marketing; Spent: 47,250.00"], sheetQuestion), true);
  assert.equal(evidenceInContexts(["Marketing 45,000.00 47,250.00 -2,250.00"], sheetQuestion), true);
  assert.equal(evidenceInContexts(["Marketing 45,000.00", "47,250.00"], sheetQuestion), false);

  const deckQuestion = { corpus: "deck", evidence: { statement: "Remind the team that Uma Xu owns the pricing follow-up." } };

  assert.equal(evidenceInContexts(["Notes:\nRemind the team that Uma Xu owns the\npricing follow-up."], deckQuestion), true);
  assert.equal(
    evidenceInContexts(["• Customer churn rose 12 percent in the first quarter"], {
      corpus: "deck",
      evidence: { statement: "Customer churn rose 12 percent in the first quarter" },
    }),
    true
  );

  const wordQuestion = { corpus: "word", gold: { spans: ["six layers"] } };

  assert.equal(evidenceInContexts(["The encoder has six layers."], wordQuestion), true);
  assert.equal(evidenceInContexts(["The encoder has six-layer blocks."], wordQuestion), false);
  assert.equal(evidenceInContexts(["anything"], { corpus: "word", gold: { spans: [] } }), null);
});

test("each arm is scored as the corpus asks: F1 for papers, the gold value otherwise", () => {
  const word = scoreArmAnswer({
    abstained: false,
    contexts: ["The encoder has six layers."],
    question: { corpus: "word", gold: { references: ["six layers"], spans: ["six layers"] } },
    text: "It has six layers.",
  });

  assert.equal(word.evidence, true);
  assert.equal(word.abstained, false);
  assert.ok(word.f1 > 0.5 && word.f1 < 1);
  assert.deepEqual(
    scoreArmAnswer({
      abstained: true,
      contexts: [],
      question: { corpus: "sheet", evidence: { key: "Marketing", value: "47,250.00" }, gold: { kind: "number", value: "47,250.00" } },
      text: "I could not find it.",
    }),
    { abstained: true, correct: false, evidence: false }
  );
});

const row = (docId, group, native, pdf) => ({ corpus: "sheet", docId, group, id: `${docId}-${group}`, native, pdf });
const arm = (correct, evidence = correct, abstained = false) => ({ abstained, correct, evidence });

test("paired deltas are native minus PDF, with intervals by question and by document", () => {
  const rows = [
    row("a", "number", arm(true), arm(false)),
    row("a", "date", arm(true), arm(true)),
    row("b", "number", arm(false), arm(true)),
    row("b", "number", arm(true), arm(false, false, true)),
  ];
  const delta = pairedArmDelta(rows, "correct", { iterations: 500, seed: 3 });

  assert.equal(delta.questions, 4);
  assert.equal(delta.documents, 2);
  assert.equal(delta.native, 0.75);
  assert.equal(delta.pdf, 0.5);
  assert.equal(delta.delta, 0.25);
  assert.deepEqual(delta.flips, { lost: 1, won: 2 });
  assert.ok(delta.ci95[0] <= 0.25 && delta.ci95[1] >= 0.25);
  assert.ok(delta.ci95ByDocument[0] <= 0.25 && delta.ci95ByDocument[1] >= 0.25);
  assert.deepEqual(pairedArmDelta(rows, "correct", { iterations: 500, seed: 3 }), delta);
  assert.equal(pairedArmDelta(rows, "answered", { iterations: 500, seed: 3 }).delta, 0.25);
  assert.equal(pairedArmDelta([], "correct").delta, null);
});

test("the summary pairs every group but notes, which only the native deck can answer", () => {
  const rows = [
    row("a", "number", arm(true), arm(false)),
    row("a", "date", arm(true), arm(true)),
    { ...row("d", "body", arm(true), arm(true)), corpus: "deck" },
    { ...row("d", "notes", arm(true), null), corpus: "deck" },
    { ...row("d", "notes", arm(false), null), corpus: "deck" },
    {
      corpus: "word",
      docId: "p",
      group: "text",
      id: "q1",
      native: { abstained: false, evidence: null, f1: 0.5 },
      pdf: { abstained: false, evidence: null, f1: 0.25 },
    },
  ];
  const summary = summarizeOfficeFormatRows(rows, { iterations: 200, seed: 1 });

  assert.deepEqual(Object.keys(summary), ["word", "sheet", "deck"]);
  assert.deepEqual(Object.keys(summary.sheet.groups), ["date", "number"]);
  assert.equal(summary.sheet.paired.correct.delta, 0.5);
  assert.deepEqual(Object.keys(summary.deck.groups), ["body"]);
  assert.equal(summary.deck.paired.correct.questions, 1);
  assert.deepEqual(summary.deck.notesNativeOnly.correct, { native: 0.5, pdfPresent: false, questions: 2 });
  assert.equal(summary.word.paired.f1.delta, 0.25);
  assert.equal(summary.word.paired.evidence.questions, 0);
  assert.deepEqual(Object.keys(summary.word.paired), CORPUS_METRICS.word);

  const markdown = formatOfficeFormatMarkdown({
    config: { chatModel: "m", embeddingModel: "e", iterations: 200 },
    failures: [{ arm: "ingest", docId: "x", reason: "DOCUMENT_ARCHIVE_INVALID" }],
    generatedAt: "2026-11-11T00:00:00.000Z",
    summary,
  });

  assert.match(markdown, /## sheet \(1 documents, 2 questions\)/);
  assert.match(markdown, /Speaker-notes questions/);
  assert.match(markdown, /- x \(ingest\): DOCUMENT_ARCHIVE_INVALID/);
});

test("notes questions are asked of the native deck only", () => {
  assert.deepEqual(armsForQuestion({ group: "notes" }), ["native"]);
  assert.deepEqual(armsForQuestion({ group: "body" }), ["native", "pdf"]);
  assert.deepEqual(armsForQuestion({ group: "text" }), ["native", "pdf"]);
});
