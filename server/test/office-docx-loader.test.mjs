// Word (.docx) pages (rag/office/docx-loader.js): the section split, labels,
// lists, tables, notes, what is never extracted, determinism and text
// coverage, over documents built by test/office-fixture-builder.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DOCUMENT_FORMAT_ERROR_CODES, DocumentFormatError } from "../rag/document-format-errors.js";
import {
  DOCX_EXTRACTOR,
  extractDocxPages,
  flattenMammothHtml,
  getMammothVersion,
  parseMammothHtml,
  splitDocxSections,
} from "../rag/office/docx-loader.js";
import { buildDocx, docxEntries, buildZip, replacePart } from "./office-fixture-builder.mjs";

const words = (text) => String(text).match(/[\p{L}\p{N}]+/gu) ?? [];

const assertCovers = (pages, visibleText) => {
  const pageWords = new Set(words(pages.map((page) => page.text).join("\n")).map((word) => word.toLowerCase()));
  const missing = words(visibleText).filter((word) => !pageWords.has(word.toLowerCase()));

  assert.deepEqual(missing, [], "every visible word reaches the pages");
};

const REPORT_BLOCKS = [
  { text: "Prepared for the board, March edition." },
  { heading: 1, text: "Executive summary" },
  { text: "Revenue grew in every region.", footnote: "Audited figures arrive in April." },
  { runs: ["First line of the address", { break: true }, "second line", { tab: true }, "after a tab"] },
  { heading: 2, text: "Regional detail" },
  { list: ["North region expanded", { level: 1, text: "Two new offices" }, "South region held steady"] },
  { list: ["Collect invoices", "Reconcile accounts"], ordered: true },
  {
    table: [
      ["Region", "Revenue", ""],
      ["North", "1,200", "flagged"],
      [{ colSpan: 2, text: "Combined total" }, "2,400"],
    ],
  },
  { heading: 1, text: "Outlook" },
  { text: "Hiring continues next quarter.", endnote: "Subject to budget approval." },
];

const REPORT = buildDocx({ blocks: REPORT_BLOCKS });

test("sections are cut at the highest heading level used, each a page starting with its heading", async () => {
  const pages = await extractDocxPages(REPORT);

  assert.deepEqual(
    pages.map(({ locationLabel, locationUnit, pageNumber }) => ({ locationLabel, locationUnit, pageNumber })),
    [
      { locationLabel: undefined, locationUnit: "section", pageNumber: 1 },
      { locationLabel: "Executive summary", locationUnit: "section", pageNumber: 2 },
      { locationLabel: "Outlook", locationUnit: "section", pageNumber: 3 },
    ]
  );
  // The preface carries no label key at all.
  assert.equal(Object.hasOwn(pages[0], "locationLabel"), false);
  assert.equal(pages[0].text, "Prepared for the board, March edition.");
  assert.equal(pages[1].text.split("\n")[0], "Executive summary");
  assert.equal(pages[2].text.split("\n")[0], "Outlook");
  // A lower heading is a line inside its section, not a cut.
  assert.ok(pages[1].text.split("\n").includes("Regional detail"));
});

test("the full text of a section: paragraphs, breaks, lists, tables and note markers", async () => {
  const pages = await extractDocxPages(REPORT);

  assert.deepEqual(pages[1].text.split("\n"), [
    "Executive summary",
    "Revenue grew in every region.[1]",
    "First line of the address second line after a tab",
    "Regional detail",
    "- North region expanded",
    "- Two new offices",
    "- South region held steady",
    "- Collect invoices",
    "- Reconcile accounts",
    "Region; Revenue",
    "Region: North; Revenue: 1,200; C: flagged",
    "Region: Combined total; C: 2,400",
  ]);
});

test("footnotes and endnotes come where mammoth puts them, after the body, numbered like their markers", async () => {
  const pages = await extractDocxPages(REPORT);

  assert.deepEqual(pages[2].text.split("\n"), [
    "Outlook",
    "Hiring continues next quarter.[2]",
    "[1] Audited figures arrive in April.",
    "[2] Subject to budget approval.",
  ]);
  // The back link mammoth appends to each note is not text.
  assert.doesNotMatch(pages.map((page) => page.text).join("\n"), /↑/);
});

test("a document whose highest heading is h2 is cut at h2; one without headings is a single unlabelled section", async () => {
  const byH2 = await extractDocxPages(
    buildDocx({
      blocks: [
        { heading: 2, text: "Scope" },
        { text: "Scope text." },
        { heading: 3, text: "Detail" },
        { heading: 2, text: "Method" },
        { text: "Method text." },
      ],
    })
  );

  assert.deepEqual(
    byH2.map((page) => [page.pageNumber, page.locationLabel, page.text]),
    [
      [1, "Scope", "Scope\nScope text.\nDetail"],
      [2, "Method", "Method\nMethod text."],
    ]
  );

  const flat = await extractDocxPages(buildDocx({ blocks: [{ text: "One paragraph." }, { text: "Another one." }] }));

  assert.deepEqual(flat, [{ locationUnit: "section", pageNumber: 1, text: "One paragraph.\nAnother one." }]);
  assert.deepEqual(await extractDocxPages(buildDocx({ blocks: [] })), []);
});

test("headers, footers, comments and pictures are not extracted", async () => {
  const pages = await extractDocxPages(
    buildDocx({
      blocks: [
        { text: "Visible paragraph." },
        { comment: "Reviewer remark here", text: "Commented sentence." },
        { alt: "Alternative picture text", image: true, text: "Caption under the picture." },
      ],
      footer: "Confidential footer",
      header: "Company letterhead",
    })
  );
  const text = pages.map((page) => page.text).join("\n");

  assert.equal(text, "Visible paragraph.\nCommented sentence.\nCaption under the picture.");
  assert.doesNotMatch(text, /letterhead|footer|Reviewer|Alternative/);
});

test("text with markup characters survives escaping both ways", async () => {
  const pages = await extractDocxPages(buildDocx({ blocks: [{ text: 'Tom & Jerry <say> "hi" & it\'s 5 > 3' }] }));

  assert.equal(pages[0].text, 'Tom & Jerry <say> "hi" & it\'s 5 > 3');
});

test("rows spanning rows keep later cells under their own header", async () => {
  const pages = await extractDocxPages(
    buildDocx({
      blocks: [
        {
          table: [
            ["Team", "Quarter", "Result"],
            [{ text: "Platform", vMerge: "restart" }, "Q1", "On track"],
            [{ text: "", vMerge: "continue" }, "Q2", "Delayed"],
          ],
        },
      ],
    })
  );

  assert.deepEqual(pages[0].text.split("\n"), [
    "Team; Quarter; Result",
    "Team: Platform; Quarter: Q1; Result: On track",
    "Quarter: Q2; Result: Delayed",
  ]);
});

test("parsing twice gives the same pages, and every visible word reaches them", async () => {
  assert.deepEqual(await extractDocxPages(REPORT), await extractDocxPages(REPORT));

  const visible = REPORT_BLOCKS.flatMap((block) => [
    block.text ?? "",
    ...(block.runs ?? []).filter((run) => typeof run === "string"),
    ...(block.list ?? []).map((item) => (typeof item === "string" ? item : item.text)),
    ...(block.table ?? []).flat().map((cell) => (typeof cell === "string" ? cell : cell.text)),
    block.footnote ?? "",
    block.endnote ?? "",
  ]);

  assertCovers(await extractDocxPages(REPORT), visible.join(" "));
});

test("a document mammoth cannot read is 400 DOCUMENT_ARCHIVE_INVALID, the parser's error kept as the cause", async () => {
  const broken = buildZip(replacePart(docxEntries({ blocks: [{ text: "x" }] }), "word/document.xml", "<w:document><w:body>"));

  await assert.rejects(extractDocxPages(broken), (error) => {
    assert.ok(error instanceof DocumentFormatError);
    assert.equal(error.status, 400);
    assert.equal(error.code, DOCUMENT_FORMAT_ERROR_CODES.archiveInvalid);
    assert.ok(error.cause instanceof Error);
    return true;
  });
});

test("mammoth's HTML parser: void elements, entities, stray and early closing tags", () => {
  assert.deepEqual(parseMammothHtml('<p>a &amp; b<br />c&#x41;&#66;&quot;&unknown;</p><img src="x" />'), [
    { attributes: {}, children: [{ text: "a & b" }, { attributes: {}, children: [], tag: "br" }, { text: 'cAB"&unknown;' }], tag: "p" },
    { attributes: { src: "x" }, children: [], tag: "img" },
  ]);
  assert.deepEqual(parseMammothHtml("</td>text<ul><li>a</ul>after"), [
    { text: "text" },
    { attributes: {}, children: [{ attributes: {}, children: [{ text: "a" }], tag: "li" }], tag: "ul" },
    { text: "after" },
  ]);
  // An out-of-range character reference stays as written.
  assert.deepEqual(parseMammothHtml("<p>&#99999999;</p>")[0].children, [{ text: "&#99999999;" }]);
});

test("headings without text neither print nor cut; checkboxes read as [x] and [ ]", () => {
  const blocks = flattenMammothHtml(
    '<h1></h1><p>Before</p><h1>Real</h1><p><input type="checkbox" checked="checked" /> Done <input type="checkbox" /> Open</p>'
  );

  assert.deepEqual(blocks, [
    { text: "Before", type: "line" },
    { level: 1, text: "Real", type: "heading" },
    { text: "[x] Done [ ] Open", type: "line" },
  ]);
  assert.deepEqual(splitDocxSections(blocks), [
    { locationUnit: "section", pageNumber: 1, text: "Before" },
    { locationLabel: "Real", locationUnit: "section", pageNumber: 2, text: "Real\n[x] Done [ ] Open" },
  ]);
});

test("a hostile column span is bounded", () => {
  const blocks = flattenMammothHtml(
    '<table><tr><td colspan="999999999">A</td><td>B</td></tr><tr><td>x</td><td colspan="5">y</td></tr></table>'
  );

  assert.deepEqual(blocks, [
    { text: "A; B", type: "line" },
    { text: "A: x; A: y", type: "line" },
  ]);
});

test("a header cell too long to be a label is written once; the column letter labels the rows", async () => {
  const longHeader = `Remarks ${"r".repeat(300)}`;
  const pages = await extractDocxPages(
    buildDocx({ blocks: [{ table: [["Name", longHeader], ["Ada", "first"], ["Bo", "second"]] }] })
  );

  assert.deepEqual(pages[0].text.split("\n"), [`Name; ${longHeader}`, "Name: Ada; B: first", "Name: Bo; B: second"]);
});

test("the text budget: a table's lines are counted as they are written, then the pages; 413 past it", async () => {
  const rows = [["Label", "Value"], ...Array.from({ length: 200 }, (_, index) => [`key ${index}`, `value ${index}`])];
  const bytes = buildDocx({ blocks: [{ heading: 1, text: "Data" }, { table: rows }, { text: "Closing words." }] });
  const pages = await extractDocxPages(bytes);
  const total = pages.reduce((sum, page) => sum + page.text.length, 0);
  const expectTooLarge = (maxTextChars) =>
    assert.rejects(extractDocxPages(bytes, { maxTextChars }), (error) => {
      assert.ok(error instanceof DocumentFormatError, String(error?.stack ?? error));
      assert.equal(error.status, 413);
      assert.equal(error.code, DOCUMENT_FORMAT_ERROR_CODES.archiveTooLarge);
      assert.match(error.message, /RAG_OFFICE_MAX_TEXT_CHARS/);
      return true;
    });

  assert.deepEqual(await extractDocxPages(bytes, { maxTextChars: total }), pages);
  await expectTooLarge(total - 1);
  // The table alone passes a small budget while its rows are written.
  await expectTooLarge(500);

  // Only table lines are spent while flattening; plain paragraphs are bounded
  // by mammoth's HTML and counted with the pages.
  const spent = [];

  flattenMammothHtml("<p>Plain text</p><table><tr><td>H</td></tr><tr><td>v</td></tr></table>", {
    budget: { spend: (length) => spent.push(length) },
  });
  assert.deepEqual(spent, ["H".length + 1, "H: v".length + 1]);
});

test("more headings than a call can take as arguments still cut into sections", () => {
  const count = 150_000;
  const blocks = Array.from({ length: count }, (_, index) => ({ level: 2 + (index % 3), text: `h${index}`, type: "heading" }));

  blocks.push({ level: 1, text: "Top", type: "heading" }, { text: "body", type: "line" });

  const pages = splitDocxSections(blocks);

  assert.equal(pages.length, 2);
  assert.equal(pages[1].text, "Top\nbody");
  assert.equal(pages[0].text.split("\n").length, count);
});

test("the extractor and its version are the installed mammoth's", () => {
  const packageJson = JSON.parse(
    readFileSync(fileURLToPath(new URL("../node_modules/mammoth/package.json", import.meta.url)), "utf8")
  );

  assert.equal(DOCX_EXTRACTOR, "mammoth");
  assert.equal(getMammothVersion(), packageJson.version);
});
