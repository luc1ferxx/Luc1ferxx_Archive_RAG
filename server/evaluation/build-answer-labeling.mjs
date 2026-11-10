// build-answer-labeling.mjs
//
// A page for labelling the answers of a qasper-answers report by hand, and
// the matching input for eval:judge, so an LLM judge can be calibrated against
// a person (run-llm-judge.mjs reports agreement and Cohen's kappa when given
// labels). For every question the report answered, the page shows the
// question, each annotator's reference answer, the annotated evidence
// paragraphs and the system's answer, in a seeded random order; a label is one
// of the judge's verdicts. Abstentions are left out: their verdict follows
// from the annotation alone.
//
// The page keeps labels in the browser (localStorage) and exports them as
// { items: [{ id, verdict, annotationIssue, note }] }, the shape --labels of
// eval:judge reads. Everything it shows is set as text, never as markup.
//
// Usage:
//   node evaluation/build-answer-labeling.mjs --report <answers report.json> --corpus <qasper corpus.json>
//     [--out evaluation/generated/labeling] [--name <report file name>] [--seed 1]
// Writes <out>/<name>.html and <out>/<name>-judge-input.json.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readAnswered, readQasperAnswerReport } from "./compare-qasper-answer-reports.mjs";
import { getArgValue } from "./eval-cli.js";
import { createSeededRandom } from "./paired-bootstrap.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MAX_EVIDENCE_PARAGRAPHS = 6;
// Reports written before 2026-11-10 cut every prediction at this length.
export const LEGACY_PREDICTION_LIMIT = 400;

/** Answers that may be cut: exactly as long as the old reports' limit. */
export const countPossiblyTruncatedAnswers = (items) =>
  items.filter((item) => item.answer.length === LEGACY_PREDICTION_LIMIT).length;

const shuffle = (items, random) => {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));

    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }

  return shuffled;
};

/**
 * One item per question the report answered, in a seeded random order:
 * { id, question, references, unanswerable, evidence, answer, answerType }.
 * Throws when an answered question is not in the corpus: the report and the
 * corpus must be the pair the run used.
 */
export const buildLabelingItems = ({ corpus, report, seed = 1 }) => {
  const caseById = new Map((corpus.cases ?? []).map((testCase) => [testCase.id, testCase]));
  const documentByKey = new Map((corpus.documents ?? []).map((doc) => [doc.key, doc]));
  const answered = report.rows.filter((row) => readAnswered(row));
  const missing = answered.filter((row) => !caseById.has(row.id));

  if (missing.length > 0) {
    throw new Error(`${missing.length} answered question(s) of the report are not in the corpus (first: ${missing[0].id}).`);
  }

  const items = answered.map((row) => {
    const testCase = caseById.get(row.id);
    const evidence = (testCase.expectedEvidence ?? []).flatMap((entry) => {
      const pages = documentByKey.get(entry.docKey)?.pages ?? [];

      return (entry.pages ?? []).map((pageNumber) => pages[pageNumber - 1]).filter((text) => typeof text === "string" && text.trim());
    });

    return {
      answer: String(row.prediction ?? ""),
      answerType: testCase.answerType ?? null,
      evidence: evidence.slice(0, MAX_EVIDENCE_PARAGRAPHS),
      id: row.id,
      question: testCase.question,
      references: testCase.referenceAnswers ?? (testCase.referenceAnswer ? [testCase.referenceAnswer] : []),
      unanswerable: Boolean(testCase.shouldAbstain),
    };
  });

  return shuffle(items, createSeededRandom(seed));
};

/** The items as eval:judge reads them: { id, question, answer, referenceAnswer, evidence }. */
export const toJudgeInput = (items) =>
  items.map((item) => ({
    answer: item.answer,
    evidence: item.evidence,
    id: item.id,
    question: item.question,
    // Every annotator's answer; null when the question is annotated unanswerable.
    referenceAnswer: item.unanswerable ? null : item.references,
  }));

// JSON for a <script type="application/json"> block: "<" escaped so no value
// can close the element.
const toEmbeddedJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

const PAGE_STYLE = `
:root { --bg: #f5f4f0; --panel: #ffffff; --ink: #1c1c1e; --muted: #68686e; --line: #d9d7d0; --accent: #1f5fbf;
  --ok: #17794a; --part: #9a6400; --bad: #b3261e; --abst: #5a4ea6; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #151516; --panel: #1e1e20; --ink: #ececee; --muted: #9b9ba1; --line: #35353b; --accent: #82b1ff;
    --ok: #5fd08f; --part: #e3b25a; --bad: #ff8a80; --abst: #b6abf2; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.65 -apple-system, "PingFang SC", "Helvetica Neue", Arial, sans-serif; }
header { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 10px 16px;
  background: var(--bg); border-bottom: 1px solid var(--line); }
header h1 { margin: 0; font-size: 16px; font-weight: 600; }
#progress, #counts { color: var(--muted); font-size: 14px; font-variant-numeric: tabular-nums; }
.spacer { flex: 1; }
main { max-width: 860px; margin: 0 auto; padding: 16px 16px 150px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
h2 { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--muted); letter-spacing: 0.02em; }
p, li { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
ul { margin: 0; padding-left: 20px; }
#question { font-size: 18px; font-weight: 600; }
#answer { border-left: 3px solid var(--accent); padding-left: 12px; }
.evidence p + p { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); }
.tag { display: inline-block; margin-left: 8px; padding: 0 8px; border: 1px solid var(--line); border-radius: 999px; font-size: 12px; color: var(--muted); }
footer { position: fixed; left: 0; right: 0; bottom: 0; background: var(--bg); border-top: 1px solid var(--line); padding: 10px 16px; }
.row { max-width: 860px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.row + .row { margin-top: 8px; }
button, .file { font: inherit; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }
button:focus-visible, .file:focus-within, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button[data-verdict] { flex: 1 1 0; min-width: 0; font-weight: 600; white-space: nowrap; }
button[data-verdict="correct"] { color: var(--ok); }
button[data-verdict="partially_correct"] { color: var(--part); }
button[data-verdict="incorrect"] { color: var(--bad); }
button[data-verdict="abstention"] { color: var(--abst); }
button[aria-pressed="true"] { border-color: currentColor; box-shadow: inset 0 0 0 1px currentColor; }
kbd { font: 12px ui-monospace, Menlo, monospace; color: var(--muted); margin-left: 6px; }
#note { flex: 1 1 260px; font: inherit; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
label.check { display: inline-flex; gap: 6px; align-items: center; font-size: 14px; }
.file input { display: none; }
#warning { display: none; color: var(--bad); font-size: 14px; }
@media (max-width: 640px) {
  kbd { display: none; }
  button, .file { padding: 6px 8px; font-size: 14px; }
  #note { flex-basis: 100%; }
}
@media (max-height: 560px) {
  header, footer { position: static; }
}
`;

// The page's script: plain ES5-style strings on purpose, so nothing in it
// needs escaping inside this module's template literal.
const PAGE_SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById("labeling-data").textContent);
  var items = data.items;
  var storageKey = "answer-labels:" + data.name;
  var labels = {};
  var index = 0;
  var byId = function (id) { return document.getElementById(id); };

  try { labels = JSON.parse(localStorage.getItem(storageKey) || "{}") || {}; } catch (error) { labels = {}; }

  var save = function () {
    try { localStorage.setItem(storageKey, JSON.stringify(labels)); }
    catch (error) { byId("warning").style.display = "block"; }
  };
  var setText = function (id, text) { byId(id).textContent = text; };
  var fill = function (id, tag, texts, emptyText) {
    var node = byId(id);
    node.textContent = "";
    if (texts.length === 0) { node.textContent = emptyText; return; }
    texts.forEach(function (text) {
      var child = document.createElement(tag);
      child.textContent = text;
      node.appendChild(child);
    });
  };
  // "The answer is a refusal in words" is the abstention verdict the
  // annotation implies; the three others are the judge's own.
  var toVerdict = function (item, choice) {
    if (choice !== "abstention") { return choice; }
    return item.unanswerable ? "correct_abstention" : "wrong_abstention";
  };
  var toChoice = function (verdict) {
    return verdict === "correct_abstention" || verdict === "wrong_abstention" ? "abstention" : verdict;
  };
  // The footer is fixed (unless the window is short) and wraps on a narrow
  // one: keep the last section clear of it.
  var fitFooter = function () {
    var footer = document.querySelector("footer");
    var fixed = window.getComputedStyle(footer).position === "fixed";
    document.querySelector("main").style.paddingBottom = (fixed ? footer.offsetHeight + 24 : 16) + "px";
  };
  var render = function () {
    var item = items[index];
    var label = labels[item.id] || {};
    var done = items.filter(function (entry) { return labels[entry.id] && labels[entry.id].verdict; }).length;
    var counts = {};

    items.forEach(function (entry) {
      var verdict = labels[entry.id] && labels[entry.id].verdict;
      if (verdict) { counts[verdict] = (counts[verdict] || 0) + 1; }
    });
    setText("progress", "第 " + (index + 1) + " / " + items.length + " 条，已标 " + done + " 条");
    setText("counts", Object.keys(counts).sort().map(function (verdict) { return verdict + " " + counts[verdict]; }).join(" · "));
    setText("question", item.question);
    byId("unanswerable").style.display = item.unanswerable ? "inline-block" : "none";
    setText("answer-type", item.answerType || "");
    byId("answer-type").style.display = item.answerType ? "inline-block" : "none";
    fill("references", "li", item.references, "（没有参考答案）");
    fill("evidence", "p", item.evidence, item.unanswerable ? "（标注为不可回答，没有证据段落）" : "（没有标注证据段落）");
    setText("answer", item.answer || "（空）");
    Array.prototype.forEach.call(document.querySelectorAll("button[data-verdict]"), function (button) {
      button.setAttribute("aria-pressed", String(toChoice(label.verdict) === button.getAttribute("data-verdict")));
    });
    byId("issue").checked = Boolean(label.annotationIssue);
    byId("note").value = label.note || "";
    fitFooter();
    window.scrollTo(0, 0);
  };
  var move = function (step) {
    index = Math.max(0, Math.min(items.length - 1, index + step));
    render();
  };
  var update = function (change) {
    var item = items[index];
    var label = labels[item.id] || {};
    Object.keys(change).forEach(function (field) { label[field] = change[field]; });
    labels[item.id] = label;
    save();
  };
  var choose = function (choice) {
    update({ verdict: toVerdict(items[index], choice) });
    if (index < items.length - 1) { move(1); } else { render(); }
  };
  var nextUnlabeled = function () {
    for (var offset = 1; offset <= items.length; offset += 1) {
      var candidate = (index + offset) % items.length;
      if (!(labels[items[candidate].id] && labels[items[candidate].id].verdict)) { index = candidate; break; }
    }
    render();
  };
  var exportLabels = function () {
    var payload = {
      exportedAt: new Date().toISOString(),
      items: items
        .filter(function (item) { return labels[item.id] && labels[item.id].verdict; })
        .map(function (item) {
          var label = labels[item.id];
          return { annotationIssue: Boolean(label.annotationIssue), id: item.id, note: label.note || "", verdict: label.verdict };
        }),
      name: data.name,
      source: data.source,
    };
    var link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2) + "\\n"], { type: "application/json" }));
    link.download = data.name + "-labels.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  var importLabels = function (file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        (JSON.parse(String(reader.result)).items || []).forEach(function (entry) {
          if (entry && entry.id && entry.verdict) {
            labels[entry.id] = { annotationIssue: Boolean(entry.annotationIssue), note: entry.note || "", verdict: entry.verdict };
          }
        });
        save();
        render();
      } catch (error) { window.alert("这个文件不是导出的标注。"); }
    };
    reader.readAsText(file);
  };

  Array.prototype.forEach.call(document.querySelectorAll("button[data-verdict]"), function (button) {
    button.addEventListener("click", function () { choose(button.getAttribute("data-verdict")); });
  });
  byId("previous").addEventListener("click", function () { move(-1); });
  byId("next").addEventListener("click", function () { move(1); });
  byId("unlabeled").addEventListener("click", nextUnlabeled);
  byId("export").addEventListener("click", exportLabels);
  byId("import").addEventListener("change", function (event) { if (event.target.files[0]) { importLabels(event.target.files[0]); } });
  byId("issue").addEventListener("change", function (event) { update({ annotationIssue: event.target.checked }); });
  byId("note").addEventListener("input", function (event) { update({ note: event.target.value }); });
  document.addEventListener("keydown", function (event) {
    if (event.target === byId("note") || event.metaKey || event.ctrlKey || event.altKey) { return; }
    var choice = { "1": "correct", "2": "partially_correct", "3": "incorrect", "4": "abstention" }[event.key];
    if (choice) { choose(choice); }
    else if (event.key === "ArrowLeft") { move(-1); }
    else if (event.key === "ArrowRight") { move(1); }
    else if (event.key === "u") { nextUnlabeled(); }
    else if (event.key === "f") { byId("issue").checked = !byId("issue").checked; update({ annotationIssue: byId("issue").checked }); }
    else { return; }
    event.preventDefault();
  });
  window.addEventListener("resize", fitFooter);
  render();
})();
`;

/** The labelling page as one self-contained HTML document. */
export const renderLabelingPage = ({ items, name, source = {} }) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>答案标注 · ${escapeHtml(name)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<header>
  <h1>答案标注</h1>
  <span id="progress"></span>
  <span id="counts"></span>
  <span class="spacer"></span>
  <label class="file">导入<input id="import" type="file" accept="application/json"></label>
  <button id="export" type="button">导出标注</button>
</header>
<main>
  <p id="warning">这个浏览器不让页面保存进度：关闭前请先导出标注。</p>
  <section>
    <h2>问题<span id="unanswerable" class="tag">标注为不可回答</span><span id="answer-type" class="tag"></span></h2>
    <p id="question"></p>
  </section>
  <section>
    <h2>系统的回答</h2>
    <p id="answer"></p>
  </section>
  <section>
    <h2>参考答案（每位标注者一条）</h2>
    <ul id="references"></ul>
  </section>
  <section class="evidence">
    <h2>标注的证据段落</h2>
    <div id="evidence"></div>
  </section>
</main>
<footer>
  <div class="row">
    <button type="button" data-verdict="correct" aria-pressed="false">正确<kbd>1</kbd></button>
    <button type="button" data-verdict="partially_correct" aria-pressed="false">部分正确<kbd>2</kbd></button>
    <button type="button" data-verdict="incorrect" aria-pressed="false">错误<kbd>3</kbd></button>
    <button type="button" data-verdict="abstention" aria-pressed="false">其实是拒答<kbd>4</kbd></button>
  </div>
  <div class="row">
    <button id="previous" type="button">上一条<kbd>←</kbd></button>
    <button id="next" type="button">下一条<kbd>→</kbd></button>
    <button id="unlabeled" type="button">下一条未标<kbd>u</kbd></button>
    <label class="check"><input id="issue" type="checkbox">参考答案或标注有问题<kbd>f</kbd></label>
    <input id="note" type="text" placeholder="备注（可不填）" aria-label="备注">
  </div>
</footer>
<script type="application/json" id="labeling-data">${toEmbeddedJson({ items, name, source })}</script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;

const main = async () => {
  const reportPath = getArgValue("--report");
  const corpusPath = getArgValue("--corpus");

  if (!reportPath || !corpusPath) {
    throw new Error("Usage: build-answer-labeling.mjs --report <answers report.json> --corpus <qasper corpus.json> [--out <directory>] [--name <slug>] [--seed 1]");
  }

  const seed = Number(getArgValue("--seed") ?? 1);

  if (!Number.isInteger(seed) || seed < 1) {
    throw new Error(`--seed must be a positive integer; got ${JSON.stringify(getArgValue("--seed"))}.`);
  }

  const name = getArgValue("--name") ?? path.basename(reportPath).replace(/\.json$/, "");

  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("--name must contain only letters, numbers, dots, underscores, or hyphens.");
  }

  const report = await readQasperAnswerReport(reportPath);
  let corpus;

  try {
    corpus = JSON.parse(await readFile(path.resolve(process.cwd(), corpusPath), "utf8"));
  } catch (error) {
    throw new Error(`${corpusPath}: ${error.message}`);
  }

  const items = buildLabelingItems({ corpus, report, seed });

  if (items.length === 0) {
    throw new Error(`${reportPath} answered no question; there is nothing to label.`);
  }

  const possiblyTruncated = countPossiblyTruncatedAnswers(items);

  if (possiblyTruncated > 0) {
    console.warn(
      `${possiblyTruncated} answer(s) are exactly ${LEGACY_PREDICTION_LIMIT} characters long: a report written before 2026-11-10 cut predictions there, and a label on a cut answer is not a label on what was scored. Rerun eval:qasper-answers for whole answers.`
    );
  }

  const outDirectory = path.resolve(process.cwd(), getArgValue("--out") ?? path.join(__dirname, "generated", "labeling"));
  const source = {
    corpus: path.basename(corpusPath),
    generatedAt: report.generatedAt ?? null,
    gitSha: report.config?.git?.sha ?? null,
    report: path.basename(reportPath),
    seed,
  };

  await mkdir(outDirectory, { recursive: true });
  await writeFile(path.join(outDirectory, `${name}.html`), renderLabelingPage({ items, name, source }));
  await writeFile(path.join(outDirectory, `${name}-judge-input.json`), `${JSON.stringify({ items: toJudgeInput(items), source }, null, 2)}\n`);
  console.log(
    `${items.length} answers to label (${items.filter((item) => item.unanswerable).length} on questions annotated unanswerable): ${path.join(outDirectory, `${name}.html`)}`
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
