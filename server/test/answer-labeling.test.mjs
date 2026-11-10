import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLabelExport,
  buildLabelingItems,
  countPossiblyTruncatedAnswers,
  fingerprintLabelingItems,
  LEGACY_PREDICTION_LIMIT,
  MAX_EVIDENCE_PARAGRAPHS,
  mergeLabelExport,
  renderLabelingPage,
  toJudgeInput,
} from "../evaluation/build-answer-labeling.mjs";
import { JUDGE_VERDICTS, measureJudgeAgreement } from "../evaluation/run-llm-judge.mjs";

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

test("an export holds the labelled answers in the judge's shape and keeps what was noted on the others", () => {
  const items = buildLabelingItems({ corpus: buildCorpus(), report: buildReport() });
  const data = { items, name: "run", source: { report: "report.json" } };
  const [first, second, third] = items.map((item) => item.id);
  const labels = {
    [first]: { annotationIssue: true, note: "the reference is wrong", verdict: "incorrect" },
    // Flagged and noted, but no verdict: not a label, and not lost either.
    [second]: { annotationIssue: true, note: "cannot tell" },
    // Touched and cleared again: nothing to keep.
    [third]: { annotationIssue: false, note: "" },
    // A label of an answer this page does not show.
    elsewhere: { verdict: "correct" },
  };
  const exported = buildLabelExport(data, labels, "2026-11-10T00:00:00.000Z");

  assert.deepEqual(exported, {
    exportedAt: "2026-11-10T00:00:00.000Z",
    // This hand-made page data names no fingerprint.
    fingerprint: null,
    items: [{ annotationIssue: true, id: first, note: "the reference is wrong", verdict: "incorrect" }],
    name: "run",
    source: { report: "report.json" },
    unlabeled: [{ annotationIssue: true, id: second, note: "cannot tell" }],
  });
  // Every entry of `items` has a verdict, so the judge's agreement counts only real labels.
  assert.deepEqual(
    measureJudgeAgreement({
      judgments: [
        { id: first, verdict: "incorrect" },
        { id: second, verdict: "correct" },
      ],
      labels: exported.items,
    }),
    { agreement: 1, cohensKappa: null, labeledItems: 1 }
  );

  // Labels come out in the page's order whatever order they were made in.
  const all = Object.fromEntries(items.map((item) => [item.id, { verdict: "correct" }]).reverse());

  assert.deepEqual(buildLabelExport(data, all, "t").items.map((entry) => entry.id), items.map((item) => item.id));
});

test("an import restores an export, replaces the page's label for the same answer and skips what it cannot use", () => {
  const items = buildLabelingItems({ corpus: buildCorpus(), report: buildReport() });
  const data = { items, name: "run", source: {} };
  const [first, second, third] = items.map((item) => item.id);
  const exported = buildLabelExport(
    data,
    {
      [first]: { annotationIssue: false, note: "", verdict: "partially_correct" },
      [second]: { annotationIssue: true, note: "cannot tell" },
    },
    "t"
  );
  // The page already holds a verdict for the first answer and a label the file does not mention.
  const labels = { [first]: { verdict: "correct" }, [third]: { note: "kept", verdict: "incorrect" } };

  // Two entries taken; one of them changed a verdict the page held.
  assert.deepEqual(mergeLabelExport(data, labels, JSON.parse(JSON.stringify(exported))), { replaced: 1, taken: 2 });
  assert.deepEqual(labels, {
    [first]: { annotationIssue: false, note: "", verdict: "partially_correct" },
    [second]: { annotationIssue: true, note: "cannot tell" },
    [third]: { note: "kept", verdict: "incorrect" },
  });
  // The same file again changes nothing it would have to ask about.
  assert.deepEqual(mergeLabelExport(data, labels, JSON.parse(JSON.stringify(exported))), { replaced: 0, taken: 2 });

  // An export written before `unlabeled` existed, or the judge's own label array wrapped in { items }.
  const older = {};

  assert.deepEqual(mergeLabelExport(data, older, { items: [{ id: first, verdict: "wrong_abstention" }] }), { replaced: 0, taken: 1 });
  assert.deepEqual(older, { [first]: { annotationIssue: false, note: "", verdict: "wrong_abstention" } });

  // A note without a verdict never takes away a verdict the page holds.
  const judged = { [first]: { note: "mine", verdict: "correct" } };

  assert.deepEqual(mergeLabelExport(data, judged, { items: [], unlabeled: [{ annotationIssue: true, id: first, note: "older note" }] }), { replaced: 0, taken: 0 });
  assert.deepEqual(judged, { [first]: { note: "mine", verdict: "correct" } });

  // Skipped: an answer the page does not show, a verdict the judge does not know, an empty note.
  const untouched = {};

  assert.deepEqual(
    mergeLabelExport(data, untouched, {
      items: [{ id: "elsewhere", verdict: "correct" }, { id: first, verdict: "perfect" }, null],
      unlabeled: [{ id: second }, { annotationIssue: true, id: "elsewhere" }],
    }),
    { replaced: 0, taken: 0 }
  );
  assert.deepEqual(untouched, {});

  for (const notAnExport of [null, [], { items: "x" }, { labels: [] }, "text"]) {
    assert.throws(() => mergeLabelExport(data, {}, notAnExport), /not a label export/);
  }

  // The verdicts an import accepts are exactly the judge's.
  for (const verdict of JUDGE_VERDICTS) {
    assert.equal(mergeLabelExport(data, {}, { items: [{ id: first, verdict }] }).taken, 1, verdict);
  }

  // The export of a page built from other answers is refused whole; one that names no
  // fingerprint (an older export) or the same one is read.
  const fingerprinted = { ...data, fingerprint: "aaaa" };
  const target = {};

  assert.throws(() => mergeLabelExport(fingerprinted, target, { fingerprint: "bbbb", items: [{ id: first, verdict: "correct" }] }), /another report/);
  assert.deepEqual(target, {});
  assert.equal(mergeLabelExport(fingerprinted, {}, { fingerprint: "aaaa", items: [{ id: first, verdict: "correct" }] }).taken, 1);
  assert.equal(mergeLabelExport(fingerprinted, {}, { items: [{ id: first, verdict: "correct" }] }).taken, 1);
  assert.equal(buildLabelExport(fingerprinted, {}, "t").fingerprint, "aaaa");
});

const readEmbeddedData = (html) =>
  JSON.parse(html.match(/<script type="application\/json" id="labeling-data">([\s\S]*?)<\/script>/)[1]);

test("the page embeds the items as data no answer can break out of, and its script parses", () => {
  const items = buildLabelingItems({ corpus: buildCorpus(), report: buildReport() });
  const html = renderLabelingPage({ items, name: "sample<run>", source: { report: "report.json" } });

  // The hostile answer is still there as data, and closed no element: the page
  // has its two script elements and nothing else.
  assert.deepEqual(readEmbeddedData(html), {
    adoptLegacyLabels: false,
    fingerprint: fingerprintLabelingItems(items),
    items,
    name: "sample<run>",
    source: { report: "report.json" },
  });
  // The fingerprint follows the answers shown, and their order.
  assert.match(fingerprintLabelingItems(items), /^[0-9a-f]{16}$/);
  assert.notEqual(fingerprintLabelingItems(items), fingerprintLabelingItems(items.map((item) => ({ ...item, answer: `${item.answer}!` }))));
  assert.notEqual(fingerprintLabelingItems(items), fingerprintLabelingItems([...items].reverse()));
  assert.equal(html.match(/<\/script>/g).length, 2);
  assert.equal(html.includes("alert(1)</script>"), false);
  assert.match(html, /<title>答案标注 · sample&lt;run&gt;<\/title>/);

  // The page's own script is syntactically valid (compiled, not run: it needs a document).
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  assert.doesNotThrow(() => new Function(script));
  // The export and the import the page runs are the two functions tested above, as written.
  assert.ok(script.includes(buildLabelExport.toString()));
  assert.ok(script.includes(mergeLabelExport.toString()));
  // Every verdict the page can write is one the judge knows.
  for (const verdict of ["correct", "partially_correct", "incorrect", "correct_abstention", "wrong_abstention"]) {
    assert.ok(JUDGE_VERDICTS.includes(verdict));
    assert.ok(script.includes(`"${verdict}"`), verdict);
  }
});

// The page's own script, run against a stand-in for the few DOM and browser
// APIs it uses, so the tests below drive what a person's browser would run.
const openPage = (html, { confirmAnswer = true, failingStorage = false, storage = new Map() } = {}) => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const alerts = [];
  const confirms = [];
  const downloads = [];
  const windowListeners = {};
  const createElement = (attributes = {}) => {
    const listeners = {};
    const element = {
      blurred: 0,
      checked: false,
      children: [],
      files: [],
      offsetHeight: 96,
      style: {},
      value: "",
      addEventListener: (type, handler) => {
        listeners[type] = handler;
      },
      appendChild: (child) => {
        element.children.push(child);
        return child;
      },
      blur: () => {
        element.blurred += 1;
      },
      click: () => (element.download ? downloads.push({ href: element.href, name: element.download }) : element.fire("click")),
      fire: (type, event = {}) => listeners[type]?.({ preventDefault() {}, target: element, ...event }),
      getAttribute: (name) => attributes[name] ?? null,
      remove: () => {},
      setAttribute: (name, value) => {
        attributes[name] = String(value);
      },
    };
    let text = "";

    // Setting the text replaces the children, as in a browser.
    Object.defineProperty(element, "textContent", {
      get: () => text,
      set: (value) => {
        text = String(value);
        element.children = [];
      },
    });

    return element;
  };
  const byId = new Map();
  const verdictButtons = ["correct", "partially_correct", "incorrect", "abstention"].map((verdict) => createElement({ "data-verdict": verdict }));
  const regions = { footer: createElement(), main: createElement() };
  const body = createElement();
  const documentListeners = {};
  const blobs = [];
  const document = {
    addEventListener: (type, handler) => {
      documentListeners[type] = handler;
    },
    body,
    createElement: () => createElement(),
    getElementById: (id) => {
      if (!byId.has(id)) {
        byId.set(id, createElement());
      }

      return byId.get(id);
    },
    querySelector: (selector) => regions[selector],
    querySelectorAll: (selector) => (selector === "button[data-verdict]" ? verdictButtons : []),
  };

  document.getElementById("labeling-data").textContent = html.match(/<script type="application\/json" id="labeling-data">([\s\S]*?)<\/script>/)[1];

  const window = {
    addEventListener: (type, handler) => {
      windowListeners[type] = handler;
    },
    alert: (message) => alerts.push(message),
    confirm: (message) => {
      confirms.push(message);
      return confirmAnswer;
    },
    getComputedStyle: () => ({ position: "fixed" }),
    scrollTo: () => {},
  };
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => {
      if (failingStorage) {
        throw new Error("storage is not available");
      }

      storage.set(key, String(value));
    },
  };
  const url = {
    createObjectURL: (blob) => {
      blobs.push(blob);
      return `blob:${blobs.length}`;
    },
  };
  // Reads at once, as a file this small does within one task in a browser.
  const FileReaderStandIn = function FileReaderStandIn() {
    this.readAsText = (file) => {
      this.result = file.text;
      this.onload();
    };
  };

  new Function("document", "window", "localStorage", "URL", "FileReader", script)(document, window, localStorage, url, FileReaderStandIn);

  const get = (id) => document.getElementById(id);

  return {
    alerts,
    blobs,
    confirms,
    downloads,
    // What another tab's save looks like from this one.
    fireStorage: (key) => windowListeners.storage?.({ key }),
    get,
    importFile: (text) => {
      get("import").files = [{ text }];
      get("import").fire("change");
    },
    pressed: () => verdictButtons.filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.getAttribute("data-verdict")),
    press: (key, target = body, extra = {}) => documentListeners.keydown({ key, preventDefault() {}, target, ...extra }),
    stored: () => [...storage.values()].map((value) => JSON.parse(value)),
    storage,
    verdictButtons,
  };
};

// The three answered questions in a known order: q1 and q3 answerable, q2 annotated unanswerable.
const buildPageItems = () =>
  buildLabelingItems({ corpus: buildCorpus(), report: buildReport() }).sort((left, right) => left.id.localeCompare(right.id));

test("the page labels with the keyboard, keeps the labels in the browser and restores them when reopened", () => {
  const items = buildPageItems();
  const html = renderLabelingPage({ items, name: "run", source: { report: "report.json" } });
  const page = openPage(html);
  const [first, second, third] = items;

  assert.equal(page.get("progress").textContent, "第 1 / 3 条，已标 0 条");
  assert.equal(page.get("question").textContent, first.question);
  assert.equal(page.get("answer").textContent, first.answer);
  assert.deepEqual(page.get("references").children.map((child) => child.textContent), first.references);
  assert.deepEqual(page.pressed(), []);
  assert.equal(page.get("warning").style.display, undefined);

  // A verdict labels the answer shown and moves on.
  page.press("1");
  assert.equal(page.get("progress").textContent, "第 2 / 3 条，已标 1 条");
  assert.equal(page.get("question").textContent, second.question);
  // The key names the page and the answers it shows.
  assert.deepEqual([...page.storage.keys()], [`answer-labels:run:${fingerprintLabelingItems(items)}`]);
  assert.deepEqual(page.stored(), [{ [first.id]: { verdict: "correct" } }]);

  // A key held down repeats: it labels nothing further. Neither does a key that an input method is composing with.
  page.press("1", undefined, { repeat: true });
  page.press("2", undefined, { repeat: true });
  page.press("f", undefined, { repeat: true });
  page.press("3", undefined, { isComposing: true });
  assert.equal(page.get("progress").textContent, "第 2 / 3 条，已标 1 条");
  assert.deepEqual(page.stored(), [{ [first.id]: { verdict: "correct" } }]);
  // The arrows may repeat.
  page.press("ArrowLeft", undefined, { repeat: true });
  assert.equal(page.get("progress").textContent, "第 1 / 3 条，已标 1 条");
  page.press("ArrowRight", undefined, { repeat: true });
  assert.equal(page.get("progress").textContent, "第 2 / 3 条，已标 1 条");

  // "It is a refusal" becomes the abstention verdict the annotation implies.
  page.press("4");
  page.press("4");
  assert.equal(page.stored()[0][second.id].verdict, second.unanswerable ? "correct_abstention" : "wrong_abstention");
  assert.equal(page.stored()[0][third.id].verdict, third.unanswerable ? "correct_abstention" : "wrong_abstention");
  assert.notEqual(second.unanswerable, third.unanswerable);
  // The last answer stays on screen, with its choice shown.
  assert.equal(page.get("progress").textContent, "第 3 / 3 条，已标 3 条");
  assert.deepEqual(page.pressed(), ["abstention"]);
  assert.equal(page.get("counts").textContent, "correct 1 · correct_abstention 1 · wrong_abstention 1");

  // Back to the first: its verdict is shown; the flag and a note are saved with it.
  page.press("ArrowLeft");
  page.press("ArrowLeft");
  page.press("ArrowLeft");
  assert.equal(page.get("progress").textContent, "第 1 / 3 条，已标 3 条");
  assert.deepEqual(page.pressed(), ["correct"]);
  page.press("f");
  assert.equal(page.get("issue").checked, true);
  page.get("note").value = "the second reference is wrong";
  page.get("note").fire("input");
  // A digit typed into the note is text, not a verdict.
  page.press("3", page.get("note"));
  assert.deepEqual(page.stored()[0][first.id], { annotationIssue: true, note: "the second reference is wrong", verdict: "correct" });
  page.verdictButtons[1].fire("click");
  assert.equal(page.stored()[0][first.id].verdict, "partially_correct");
  // A clicked button gives up the focus, so Space or Enter cannot press it again on the next answer.
  assert.equal(page.verdictButtons[1].blurred, 1);
  page.get("next").fire("click");
  page.get("previous").fire("click");
  page.get("previous").fire("click");
  assert.deepEqual([page.get("next").blurred, page.get("previous").blurred], [1, 2]);
  assert.equal(page.get("progress").textContent, "第 1 / 3 条，已标 3 条");

  // Reopened on the same storage, the page has everything back.
  const reopened = openPage(html, { storage: page.storage });

  assert.equal(reopened.get("progress").textContent, "第 1 / 3 条，已标 3 条");
  assert.deepEqual(reopened.pressed(), ["partially_correct"]);
  assert.equal(reopened.get("issue").checked, true);
  assert.equal(reopened.get("note").value, "the second reference is wrong");
  assert.equal(reopened.get("warning").style.display, undefined);
});

test("the page jumps to the next unlabelled answer, and a browser that cannot store says so without losing the session", async () => {
  const items = buildPageItems();
  const html = renderLabelingPage({ items, name: "run", source: { report: "report.json" } });
  const [first, second, third] = items;
  const fingerprint = fingerprintLabelingItems(items);
  const key = `answer-labels:run:${fingerprint}`;
  // Stored text that is not JSON is ignored, not fatal.
  const page = openPage(html, { failingStorage: true, storage: new Map([[key, "{not json"]]) });

  assert.equal(page.get("progress").textContent, "第 1 / 3 条，已标 0 条");
  page.press("ArrowRight");
  page.press("2");
  assert.equal(page.get("warning").style.display, "block");
  assert.equal(page.get("progress").textContent, "第 3 / 3 条，已标 1 条");
  // From the third answer the next unlabelled one is the first; then the third again.
  page.press("u");
  assert.equal(page.get("question").textContent, first.question);
  page.press("u");
  assert.equal(page.get("question").textContent, third.question);
  page.press("f");

  // The export still holds the session: one label, and the flagged answer without a verdict.
  page.get("export").fire("click");
  assert.deepEqual(page.downloads, [{ href: "blob:1", name: "run-labels.json" }]);
  assert.equal(page.blobs[0].type, "application/json");

  const exported = JSON.parse(await page.blobs[0].text());

  assert.match(exported.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    { ...exported, exportedAt: "t" },
    buildLabelExport(
      { fingerprint, items, name: "run", source: { report: "report.json" } },
      { [second.id]: { verdict: "partially_correct" }, [third.id]: { annotationIssue: true } },
      "t"
    )
  );
  assert.deepEqual([exported.items.length, exported.unlabeled.length, exported.fingerprint], [1, 1, fingerprint]);

  // Imported into a fresh page, the session is back and saved.
  const fresh = openPage(html);

  fresh.importFile(JSON.stringify(exported));
  assert.equal(fresh.get("progress").textContent, "第 1 / 3 条，已标 1 条");
  assert.deepEqual(fresh.stored(), [
    { [second.id]: { annotationIssue: false, note: "", verdict: "partially_correct" }, [third.id]: { annotationIssue: true, note: "" } },
  ]);
  assert.deepEqual(fresh.alerts, []);

  // What is not an export, or holds nothing for this page, is said and changes nothing.
  fresh.importFile("not json");
  fresh.importFile(JSON.stringify({ rows: [] }));
  fresh.importFile(JSON.stringify({ items: [{ id: "elsewhere", verdict: "correct" }] }));
  fresh.importFile(JSON.stringify({ fingerprint: "of-another-report", items: [{ id: second.id, verdict: "correct" }] }));
  assert.deepEqual(fresh.alerts, [
    "这个文件不是导出的标注。",
    "这个文件不是导出的标注。",
    "这个文件里没有这一页答案的标注。",
    "这个文件是另一份报告的标注，不能导入这一页。",
  ]);
  assert.equal(fresh.get("progress").textContent, "第 1 / 3 条，已标 1 条");
  assert.deepEqual(fresh.confirms, []);

  // A file that would change a verdict the page holds asks first; a no leaves everything as it was.
  const changed = JSON.stringify({ fingerprint, items: [{ id: second.id, verdict: "incorrect" }, { id: first.id, verdict: "correct" }] });
  const careful = openPage(html, { confirmAnswer: false, storage: fresh.storage });

  careful.importFile(changed);
  assert.deepEqual(careful.confirms, ["文件里有 1 条结论与这一页现有的不同。用文件里的覆盖吗？"]);
  assert.equal(careful.stored()[0][second.id].verdict, "partially_correct");
  assert.equal(careful.stored()[0][first.id], undefined);

  const agreeing = openPage(html, { storage: fresh.storage });

  agreeing.importFile(changed);
  assert.equal(agreeing.confirms.length, 1);
  assert.deepEqual([agreeing.stored()[0][second.id].verdict, agreeing.stored()[0][first.id].verdict], ["incorrect", "correct"]);
  assert.equal(agreeing.get("progress").textContent, "第 1 / 3 条，已标 2 条");

  // Stored JSON that is not a label map is not used as one, and saving still works.
  const odd = openPage(html, { storage: new Map([[key, "[]"]]) });

  assert.equal(odd.get("progress").textContent, "第 1 / 3 条，已标 0 条");
  odd.press("1");
  assert.deepEqual(odd.stored(), [{ [first.id]: { verdict: "correct" } }]);
});

test("two tabs of the page do not roll each other back", () => {
  const items = buildPageItems();
  const html = renderLabelingPage({ items, name: "run", source: {} });
  const key = `answer-labels:run:${fingerprintLabelingItems(items)}`;
  const [first, second, third] = items;
  const storage = new Map();
  const tabA = openPage(html, { storage });
  const tabB = openPage(html, { storage });

  tabA.press("1");
  // The other tab was opened before that label and does not show it yet.
  assert.equal(tabB.get("progress").textContent, "第 1 / 3 条，已标 0 条");
  tabB.press("ArrowRight");
  tabB.press("3");
  // Its save changes its own answer and keeps the first tab's label.
  assert.deepEqual(JSON.parse(storage.get(key)), { [first.id]: { verdict: "correct" }, [second.id]: { verdict: "incorrect" } });
  assert.equal(tabB.get("progress").textContent, "第 3 / 3 条，已标 2 条");

  // The first tab hears of that save and shows it, staying on its answer.
  tabA.fireStorage("some-other-key");
  assert.equal(tabA.get("progress").textContent, "第 2 / 3 条，已标 1 条");
  tabA.fireStorage(key);
  assert.equal(tabA.get("progress").textContent, "第 2 / 3 条，已标 2 条");
  assert.deepEqual(tabA.pressed(), ["incorrect"]);

  // A tab whose own saves fail keeps what it holds instead of taking older stored labels over it.
  const stuck = openPage(html, { failingStorage: true, storage });

  stuck.press("2");
  assert.equal(stuck.get("warning").style.display, "block");
  storage.set(key, JSON.stringify({ [first.id]: { verdict: "correct" }, [second.id]: { verdict: "incorrect" }, [third.id]: { verdict: "correct" } }));
  stuck.press("2");
  stuck.get("export").fire("click");
  assert.equal(stuck.downloads.length, 1);
  assert.equal(stuck.get("progress").textContent, "第 3 / 3 条，已标 2 条");
});

test("labels stay with the answers they were made on, and an earlier build's labels are taken over only when asked", () => {
  const items = buildPageItems();
  const [first] = items;
  const html = renderLabelingPage({ items, name: "run", source: {} });
  const key = `answer-labels:run:${fingerprintLabelingItems(items)}`;
  const page = openPage(html);

  page.press("1");

  // The page rebuilt under the same name from another run's answers starts clean.
  const rerun = items.map((item) => ({ ...item, answer: `${item.answer} (another run)` }));
  const rebuilt = openPage(renderLabelingPage({ items: rerun, name: "run", source: {} }), { storage: page.storage });

  assert.equal(rebuilt.get("progress").textContent, "第 1 / 3 条，已标 0 条");
  rebuilt.press("3");
  assert.equal(page.storage.size, 2);
  assert.deepEqual(JSON.parse(page.storage.get(key)), { [first.id]: { verdict: "correct" } });

  // Labels saved by a build from before the key named the answers sit under the name alone.
  const legacy = new Map([["answer-labels:run", JSON.stringify({ [first.id]: { note: "from the first build", verdict: "incorrect" } })]]);

  assert.equal(openPage(html, { storage: legacy }).get("progress").textContent, "第 1 / 3 条，已标 0 条");
  assert.equal(legacy.size, 1);

  const adopting = openPage(renderLabelingPage({ adoptLegacyLabels: true, items, name: "run", source: {} }), { storage: legacy });

  assert.equal(adopting.get("progress").textContent, "第 1 / 3 条，已标 1 条");
  assert.deepEqual(adopting.pressed(), ["incorrect"]);
  assert.equal(adopting.get("note").value, "from the first build");
  // Taken over once: saved under the new key, and what is saved there since wins.
  assert.deepEqual(JSON.parse(legacy.get(key)), { [first.id]: { note: "from the first build", verdict: "incorrect" } });
  adopting.press("1");
  legacy.set("answer-labels:run", JSON.stringify({}));
  assert.deepEqual(openPage(renderLabelingPage({ adoptLegacyLabels: true, items, name: "run", source: {} }), { storage: legacy }).pressed(), ["correct"]);
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
    assert.equal(page.adoptLegacyLabels, false);
    assert.match(page.fingerprint, /^[0-9a-f]{16}$/);

    const adopting = run(["--report", reportPath, "--corpus", corpusPath, "--out", outDirectory, "--name", "adopting", "--adopt-legacy-labels"]);

    assert.equal(adopting.status, 0, adopting.stderr);
    assert.equal(readEmbeddedData(await readFile(path.join(outDirectory, "adopting.html"), "utf8")).adoptLegacyLabels, true);
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
