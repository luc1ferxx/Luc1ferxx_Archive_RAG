// Excel (.xlsx) pages (rag/office/xlsx-loader.js, rag/office/xlsx-plan.js):
// visible sheets and their numbering, header detection, title rows,
// displayed values, formulas, dates, merged ranges, the cell cap and the
// pre-parse bound, the rebuilt workbook SheetJS reads (and the parts it never
// sees), number formats, the text budget, determinism and text coverage,
// over workbooks built by test/office-fixture-builder.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DOCUMENT_FORMAT_ERROR_CODES, DocumentFormatError } from "../rag/document-format-errors.js";
import { prepareWorksheets, readWorkbookParts } from "../rag/office/xlsx-plan.js";
import { scanOfficeArchive } from "../rag/office/zip-guard.js";
import * as XLSX from "xlsx";

import {
  SHEETJS_IMPLICIT_NUMBER_FORMATS,
  XLSX_CELL_PRECHECK_FACTOR,
  XLSX_EXTRACTOR,
  extractXlsxPages,
  findHeaderRow,
  getSheetjsVersion,
  prepareWorksheetPart,
  readSheetRows,
  workbookToPages,
} from "../rag/office/xlsx-loader.js";
import { buildXlsx, buildZip, replacePart, xlsxEntries, zipEntriesFromParts } from "./office-fixture-builder.mjs";

const CODES = DOCUMENT_FORMAT_ERROR_CODES;

const words = (text) => String(text).match(/[\p{L}\p{N}]+/gu) ?? [];

const expectRefusal = (promise, { code, status }) =>
  assert.rejects(Promise.resolve().then(() => promise), (error) => {
    assert.ok(error instanceof DocumentFormatError, String(error?.stack ?? error));
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });

const expectSpreadsheetTooLarge = (callback) =>
  expectRefusal(Promise.resolve().then(callback), { code: CODES.spreadsheetTooLarge, status: 413 });

const SALES_SHEETS = [
  {
    merges: ["A1:D1"],
    name: "Sales",
    rows: [
      ["Quarterly sales report"],
      ["Prepared by finance"],
      null,
      ["Region", "Units", "Revenue", "Closed on", "", "Share"],
      ["North", 120, { format: "money", value: 1234.5 }, { date: "2024-01-15" }, "late", { format: "percent", value: 0.25 }],
      ["South", { formula: "B5-20", value: 100 }, { formula: "C5*2", value: 2469 }, { date: "2024-02-01", format: "iso" }],
      ["Total", { formula: "SUM(B5:B6)", value: 999 }, null, null, null, { error: "#DIV/0!" }],
      [null, null, true, { styledEmpty: true }],
    ],
  },
  { name: "Lookup", rows: [["internal code", "hidden value"]], state: "hidden" },
  { chart: true, name: "Trend chart" },
  { name: "Archive", rows: [["very hidden note"]], state: "veryHidden" },
  { name: "Notes", rows: [["Remember the audit"], ["Second note line"]] },
  { name: "Blank", rows: [[null, { styledEmpty: true }]] },
];
const SALES = buildXlsx({ sheets: SALES_SHEETS });

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const S_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// A worksheet of `rows` (arrays of numbers), written by hand.
const worksheetXml = (rows, { prefix = "", tail = "" } = {}) => {
  const p = prefix ? `${prefix}:` : "";
  const namespace = prefix ? `xmlns:${prefix}="http://schemas.openxmlformats.org/spreadsheetml/2006/main"` : S_NS;

  return (
    `${XML_DECLARATION}<${p}worksheet ${namespace}><${p}sheetData>` +
    rows
      .map(
        (row, rowIndex) =>
          `<${p}row r="${rowIndex + 1}">` +
          row.map((value, column) => `<${p}c r="${String.fromCharCode(65 + column)}${rowIndex + 1}"><${p}v>${value}</${p}v></${p}c>`).join("") +
          `</${p}row>`
      )
      .join("") +
    `</${p}sheetData>${tail}</${p}worksheet>`
  );
};

const numberRows = (count, width = 2) => Array.from({ length: count }, (_, row) => Array.from({ length: width }, (__, column) => row * width + column));

const sheetWithStyles = (stylesXml, rows) =>
  buildXlsx({
    sheets: [{ name: "S", rows }],
    transform: (entries) => replacePart(entries, "xl/styles.xml", stylesXml),
  });

const escapeAttribute = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const stylesWithFormat = (formatCode) =>
  `${XML_DECLARATION}<styleSheet ${S_NS}>` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="${escapeAttribute(formatCode)}"/></numFmts>` +
  `<fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
  `<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>` +
  `<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`;

test("one page per visible worksheet, numbered by workbook position, labelled by name", async () => {
  const pages = await extractXlsxPages(SALES);

  assert.deepEqual(
    pages.map(({ locationLabel, locationUnit, pageNumber }) => ({ locationLabel, locationUnit, pageNumber })),
    [
      { locationLabel: "Sales", locationUnit: "sheet", pageNumber: 1 },
      { locationLabel: "Notes", locationUnit: "sheet", pageNumber: 5 },
    ]
  );

  const text = pages.map((page) => page.text).join("\n");

  // Hidden, very hidden, chart and empty sheets give no page.
  assert.doesNotMatch(text, /internal code|hidden value|very hidden|Trend chart|Blank/);
});

test("title rows above the header are plain; the header row is plain; later rows are labelled", async () => {
  const [sales] = await extractXlsxPages(SALES);

  assert.deepEqual(sales.text.split("\n"), [
    "Sheet: Sales",
    "Quarterly sales report",
    "Prepared by finance",
    "Region; Units; Revenue; Closed on; Share",
    "Region: North; Units: 120; Revenue: 1,234.50; Closed on: 1/15/24; E: late; Share: 25.00%",
    "Region: South; Units: 100; Revenue: 2469; Closed on: 2024-02-01",
    "Region: Total; Units: 999; Share: #DIV/0!",
    "Revenue: TRUE",
  ]);
});

test("formulas read as their cached values, never evaluated", async () => {
  const pages = await extractXlsxPages(
    buildXlsx({
      sheets: [
        {
          name: "Calc",
          rows: [
            ["Input", "Result"],
            [2, { formula: "A2*2", value: 5 }],
            [3, { formula: "A3&\"x\"", value: "cached text" }],
            [4, { formula: "A4>1", value: false }],
          ],
        },
      ],
    })
  );

  assert.deepEqual(pages[0].text.split("\n").slice(2), [
    "Input: 2; Result: 5",
    "Input: 3; Result: cached text",
    "Input: 4; Result: FALSE",
  ]);
});

test("the header is the first of the first 20 non-empty rows with two cells and half the widest row's", async () => {
  const row = (count, prefix = "c") => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
  const rowsOf = (...counts) => counts.map((count, index) => ({ cells: row(count, `r${index}`).map((text, column) => ({ column, text })), row: index }));

  assert.equal(findHeaderRow(rowsOf(1, 6, 6)), 1);
  // Two cells, but fewer than half of the widest (6): not the header.
  assert.equal(findHeaderRow(rowsOf(2, 6, 6)), 1);
  assert.equal(findHeaderRow(rowsOf(3, 6, 6)), 0);
  assert.equal(findHeaderRow(rowsOf(1, 1, 1)), -1);
  // A wide row after the twentieth non-empty row is never the header.
  assert.equal(findHeaderRow(rowsOf(...Array(20).fill(1), 5, 5)), -1);

  // Through the workbook: single cells only, so every line is plain.
  const pages = await extractXlsxPages(buildXlsx({ sheets: [{ name: "List", rows: [["alpha"], ["beta"], [null, "gamma"]] }] }));

  assert.equal(pages[0].text, "Sheet: List\nalpha\nbeta\ngamma");
});

test("a cell under an empty header is labelled by its column letter, far columns too", async () => {
  const wide = Array(30).fill(null);

  wide[0] = "Key";
  wide[1] = "Value";

  const value = Array(30).fill(null);

  value[0] = "k1";
  value[29] = "far right";

  const pages = await extractXlsxPages(buildXlsx({ sheets: [{ name: "Wide", rows: [wide, value] }] }));

  assert.equal(pages[0].text.split("\n")[2], "Key: k1; AD: far right");
});

test("a header too long to be a label is written once; its column letter labels the rows", async () => {
  const longHeader = `Comment ${"c".repeat(300)}`;
  const pages = await extractXlsxPages(buildXlsx({ sheets: [{ name: "L", rows: [["Name", longHeader], ["Ada", "x"], ["Bo", "y"]] }] }));

  assert.deepEqual(pages[0].text.split("\n"), ["Sheet: L", `Name; ${longHeader}`, "Name: Ada; B: x", "Name: Bo; B: y"]);
});

test("a merged range keeps its value in the top-left cell only", async () => {
  const pages = await extractXlsxPages(
    buildXlsx({
      sheets: [
        {
          merges: ["A1:C1", "B3:C4"],
          name: "Merged",
          rows: [
            ["Banner", "stray covered value", "another stray"],
            ["H1", "H2", "H3"],
            ["a", "merged top-left", "covered right"],
            ["b", "covered below", "covered corner"],
          ],
        },
      ],
    })
  );

  assert.deepEqual(pages[0].text.split("\n"), [
    "Sheet: Merged",
    "Banner",
    "H1; H2; H3",
    "H1: a; H2: merged top-left",
    "H1: b",
  ]);
});

test("merged ranges are looked up by binary search over coalesced intervals", () => {
  // One row of 4,000 cells and 20,000 one-row ranges, overlapping, adjacent
  // and nested: a linear scan per cell is 80 million checks.
  const columns = 4000;
  const row = Array.from({ length: columns }, (_, column) => ({ t: "s", v: `v${column}`, w: `v${column}` }));
  const merges = [];

  for (let index = 0; index < 20_000; index += 1) {
    const start = (index * 7) % (columns - 10);

    merges.push({ e: { c: start + (index % 3), r: 0 }, s: { c: start, r: 0 } });
  }

  const rows = readSheetRows({ "!data": [row], "!merges": merges }, { maxCells: 1_000_000 });
  const covered = new Set();

  for (const { e: end, s: start } of merges) {
    for (let column = start.c + 1; column <= end.c; column += 1) {
      covered.add(column);
    }
  }

  assert.deepEqual(
    rows[0].cells.map((cell) => cell.column),
    Array.from({ length: columns }, (_, column) => column).filter((column) => !covered.has(column))
  );
});

test("shared strings and styles the relationships leave out are found through [Content_Types].xml", async () => {
  const sheets = [{ name: "S", rows: [["Name", "Paid"], ["Ada", { format: "money", value: 1234.5 }]] }];
  const withoutRelationships = buildXlsx({
    sheets,
    transform: (entries) =>
      entries.map((entry) =>
        entry.name === "xl/_rels/workbook.xml.rels"
          ? { ...entry, data: String(entry.data).replace(/<Relationship Id="rId(?:Strings|Styles)"[^>]*\/>/g, "") }
          : entry
      ),
  });

  assert.deepEqual(await extractXlsxPages(withoutRelationships), await extractXlsxPages(buildXlsx({ sheets })));
  assert.equal((await extractXlsxPages(withoutRelationships))[0].text.split("\n")[2], "Name: Ada; Paid: 1,234.50");
});

test("dates follow the workbook's date1904", async () => {
  const pages = await extractXlsxPages(
    buildXlsx({
      sheets: [{ name: "D", rows: [["When", "x"], [{ date: "2024-01-15" }, 1]] }],
      transform: (entries) =>
        entries.map((entry) =>
          entry.name === "xl/workbook.xml" ? { ...entry, data: String(entry.data).replace("<bookViews>", '<workbookPr date1904="1"/><bookViews>') } : entry
        ),
    })
  );

  // The 1900-system serial of 2024-01-15 read in the 1904 system.
  assert.equal(pages[0].text.split("\n")[2], "When: 1/16/28; x: 1");
});

test("shared and inline strings read the same", async () => {
  const sheets = [{ name: "S", rows: [["Name", "City"], ["Ada", "London"]] }];

  assert.deepEqual(await extractXlsxPages(buildXlsx({ sharedStrings: false, sheets })), await extractXlsxPages(buildXlsx({ sheets })));
});

test("more non-empty cells than RAG_XLSX_MAX_CELLS in the visible sheets refuse the workbook; hidden cells do not count", async () => {
  const visible = { name: "Visible", rows: [["a", "b"], ["c", "d"]] };
  const hidden = { name: "Hidden", rows: Array.from({ length: 50 }, (_, index) => [`h${index}`, index]), state: "hidden" };
  const bytes = buildXlsx({ sheets: [visible, hidden] });

  assert.equal((await extractXlsxPages(bytes, { maxCells: 4 })).length, 1);
  await expectSpreadsheetTooLarge(() => extractXlsxPages(bytes, { maxCells: 3 }));

  process.env.RAG_XLSX_MAX_CELLS = "3";

  try {
    await expectSpreadsheetTooLarge(() => extractXlsxPages(bytes));
  } finally {
    delete process.env.RAG_XLSX_MAX_CELLS;
  }
});

test("the pre-parse bound counts the cell elements of the visible worksheets as SheetJS finds them", async () => {
  // Each row: its cells, plus the one cell SheetJS may take from the text
  // before a row's first cell element; plus one for the sheet.
  assert.equal(prepareWorksheetPart(Buffer.from(worksheetXml(numberRows(3)))).cellElements, 3 * 2 + 3 + 1);
  // Prefixed elements, attributes, self-closing and styled empty cells and
  // merged ranges count; a value tag alone does not.
  const counted = prepareWorksheetPart(
    Buffer.from(
      '<x:worksheet xmlns:x="m"><x:sheetData><x:row><x:c r="A1"><x:v xml:space="preserve">1</x:v></x:c><c s="1"/><c>' +
        '<v>2</v></c></x:row></x:sheetData><x:mergeCells><x:mergeCell ref="A1:B1"/></x:mergeCells><v>9</v></x:worksheet>'
    )
  );

  assert.equal(counted.cellElements, 3 + 1 + 1 + 1);
  assert.equal(XLSX_CELL_PRECHECK_FACTOR, 2);

  // Through the plan: visible sheets only, against 2 x maxCells.
  const bytes = buildXlsx({
    sheets: [
      { name: "Shown", rows: numberRows(3) },
      { name: "Hidden", rows: numberRows(40), state: "hidden" },
    ],
  });
  const archive = await scanOfficeArchive(bytes);
  const parts = await readWorkbookParts(archive);
  const sheets = [
    { hidden: false, id: "rId1" },
    { hidden: true, id: "rId2" },
  ];
  const elements = 3 * 2 + 3 + 1;

  assert.deepEqual(
    (await prepareWorksheets(archive, { relationships: parts.relationships, sheets }, { maxCells: elements / 2 })).map(({ index }) => index),
    [0]
  );
  await expectSpreadsheetTooLarge(() =>
    prepareWorksheets(archive, { relationships: parts.relationships, sheets }, { maxCells: elements / 2 - 1 })
  );
});

test("the byte scan counts exactly what SheetJS's patterns match", () => {
  const SHEETJS_PATTERNS = /<(?:\w+:)?c[ \/>]|<\/(?:\w+:)?row>|<(?:\w+:)?mergeCell[\s/>]/g;
  const samples = [
    '<c r="A1"><v>1</v></c><c/><c>',
    "<x:c ><ab_1:c/><c:c>",
    "<:c ><a:b:c ><cx ><c\t><C ><c:x >",
    "</row></x:row></row ></rows></:row></a:b:row>",
    "<mergeCells><mergeCell ref=\"A1:B2\"/><x:mergeCell\n/><mergeCell x><mergeCellx/>",
    "<<c <<</row><c",
    "text without tags",
    "<é:c ><cé>",
  ];

  for (const sample of samples) {
    const bytes = Buffer.from(sample, "latin1");
    const expected = (bytes.toString("latin1").match(SHEETJS_PATTERNS) ?? []).length + 1;

    assert.equal(prepareWorksheetPart(bytes).cellElements, expected, JSON.stringify(sample));
  }

  // Hyperlinks, prefixed or not, are renamed so SheetJS's pattern finds none;
  // nothing else changes.
  const linked = Buffer.from('<a><hyperlink ref="A1:B2"/><x:hyperlink ref="A1"/><hyperlinks><hyperlinkx /></a>', "latin1");
  const renamed = prepareWorksheetPart(linked).bytes.toString("latin1");

  assert.equal(renamed, '<a><hyperlink-not-read ref="A1:B2"/><x:hyperlink-not-read ref="A1"/><hyperlinks><hyperlinkx /></a>');
  assert.equal(/<(?:\w+:)?hyperlink [^<>]*>/.test(renamed), false);
});

test("a worksheet SheetJS would parse is counted whatever its part name, prefix or encoding", async () => {
  const rows = numberRows(20);
  const elements = 20 * 2 + 20 + 1;
  const withWorksheet = (name, data, extra = {}) =>
    buildZip(
      zipEntriesFromParts({
        "[Content_Types].xml":
          `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          (extra.contentTypes ?? "") +
          "</Types>",
        "_rels/.rels":
          `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        "xl/workbook.xml": `${XML_DECLARATION}<workbook ${S_NS} xmlns:r="${REL}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels":
          `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="${REL}/worksheet" Target="${name.replace(/^xl\//, "")}"/></Relationships>`,
        [name]: data,
        ...(extra.parts ?? {}),
      })
    );
  const cases = {
    // A part SheetJS reads whatever its extension.
    dat: withWorksheet("xl/worksheets/sheet1.dat", worksheetXml(rows)),
    // Prefixed elements, which SheetJS reads like plain ones.
    prefixed: withWorksheet("xl/worksheets/sheet1.xml", worksheetXml(rows, { prefix: "x" })),
    // UTF-16 with a byte order mark, which SheetJS decodes itself.
    utf16: withWorksheet(
      "xl/worksheets/sheet1.xml",
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(worksheetXml(rows), "utf16le")])
    ),
    // A first workbook override in [Content_Types].xml naming another part
    // (here a binary workbook): SheetJS used to read that one; the guard's
    // main part, named by _rels/.rels, is the workbook read.
    decoy: withWorksheet("xl/worksheets/sheet1.xml", worksheetXml(rows), {
      contentTypes: '<Override PartName="/xl/decoy.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>',
      parts: { "xl/decoy.bin": Buffer.from("not a workbook") },
    }),
  };

  for (const [label, bytes] of Object.entries(cases)) {
    const pages = await extractXlsxPages(bytes);

    assert.equal(pages.length, 1, label);
    assert.equal(pages[0].text.split("\n")[2], "0: 2; 1: 3", label);

    const archive = await scanOfficeArchive(bytes);
    const parts = await readWorkbookParts(archive);
    const plan = (maxCells) =>
      prepareWorksheets(archive, { relationships: parts.relationships, sheets: [{ hidden: false, id: "rId1" }] }, { maxCells });

    assert.equal((await plan(Math.ceil(elements / 2))).length, 1, label);
    await expectSpreadsheetTooLarge(() => plan(Math.floor(elements / 2)));
  }
});

test("SheetJS reads only the rebuilt workbook: comments, hyperlinks and other parts never reach it", async () => {
  // A hyperlink over the whole sheet would make SheetJS give every one of
  // its 17 billion cells a stub; the tag is renamed before SheetJS sees it.
  const hyperlinked = prepareWorksheetPart(
    Buffer.from(worksheetXml([[1, 2]], { tail: '<hyperlinks><hyperlink ref="A1:XFD1048576" location="Sheet1!A1"/></hyperlinks>' }))
  );

  assert.doesNotMatch(hyperlinked.bytes.toString("latin1"), /<hyperlink /);

  // A small range end to end: the page is what it was.
  const bytes = buildXlsx({
    sheets: [{ name: "Linked", rows: [["Key", "Value"], ["k", 1]] }],
    transform: (entries) =>
      replacePart(
        entries,
        "xl/worksheets/sheet1.xml",
        worksheetXml([[1, 2], [3, 4]], { tail: '<hyperlinks><x:hyperlink xmlns:x="m" ref="A1:J10" location="A1"/></hyperlinks>' })
      ),
  });

  assert.deepEqual((await extractXlsxPages(bytes))[0].text.split("\n"), ["Sheet: Linked", "1; 2", "1: 3; 2: 4"]);
});

test("a worksheet still starting the way SheetJS takes for UTF-16 is refused", async () => {
  assert.throws(
    () => prepareWorksheetPart(Buffer.from([0x3c, 0xfe, 0xff, 0x3c])),
    (error) => error instanceof DocumentFormatError && error.status === 400 && error.code === CODES.archiveInvalid
  );
});

test("number formats too long for Excel or repeating the text placeholder are refused before any cell is formatted", async () => {
  const rows = [["Name", "Amount"], ["a", { format: "money", value: 1 }]];

  for (const formatCode of [`0${'"x"'.repeat(100)}`, "@@", "0;@ @"]) {
    await expectRefusal(extractXlsxPages(sheetWithStyles(stylesWithFormat(formatCode), rows)), {
      code: CODES.archiveInvalid,
      status: 400,
    });
  }

  // One placeholder per section, a literal around it, is a format like any other.
  for (const formatCode of ["@", '"Note: "@', "0;-0;0;@", "_(@_)"]) {
    const pages = await extractXlsxPages(sheetWithStyles(stylesWithFormat(formatCode), rows));

    assert.equal(pages.length, 1, formatCode);
  }
});

// A workbook whose cells use built-in, implicit (used but never defined) and
// custom number formats, ids past SheetJS's 392 slots and a format SheetJS
// rewrites ("d.m"), over numbers, strings, booleans, errors and formula text.
const FORMAT_IDS = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 14, 15, 18, 20, 22, 27, 37, 41, 44, 45, 47, 49, 56, 59, 67, 69, 80, 81, 82, 164, 165, 166, 167, 400];
const formattedWorkbook = ({ date1904 = false } = {}) =>
  buildZip(
    zipEntriesFromParts({
      "[Content_Types].xml":
        `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
      "_rels/.rels":
        `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml":
        `${XML_DECLARATION}<workbook ${S_NS} xmlns:r="${REL}">${date1904 ? '<workbookPr date1904="1"/>' : ""}` +
        '<sheets><sheet name="F" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
      "xl/styles.xml":
        `${XML_DECLARATION}<styleSheet ${S_NS}><numFmts>` +
        '<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>' +
        '<numFmt numFmtId="165" formatCode="&quot;Total: &quot;#,##0.00;[Red]\\-#,##0.00;&quot;zero&quot;;&quot;Text: &quot;@"/>' +
        '<numFmt numFmtId="166" formatCode="0.000E+00"/><numFmt numFmtId="167" formatCode="d.m"/><numFmt numFmtId="400" formatCode="0.0%"/>' +
        `</numFmts><cellXfs>${FORMAT_IDS.map((id) => `<xf numFmtId="${id}"/>`).join("")}</cellXfs></styleSheet>`,
      "xl/sharedStrings.xml": `${XML_DECLARATION}<sst ${S_NS}><si><t>alpha</t></si><si><t>Beta gamma</t></si></sst>`,
      "xl/worksheets/sheet1.xml":
        `${XML_DECLARATION}<worksheet ${S_NS}><sheetData>` +
        [
          ...["45306.75", "-1234.5678", "0", "1E+300"].map((value) => FORMAT_IDS.map((_, style) => `<c s="${style}"><v>${value}</v></c>`)),
          FORMAT_IDS.map((_, style) => `<c s="${style}" t="s"><v>${style % 2}</v></c>`),
          FORMAT_IDS.map((_, style) => `<c s="${style}" t="b"><v>${style % 2}</v></c>`),
          FORMAT_IDS.map((_, style) => `<c s="${style}" t="e"><v>${["#N/A", "#DIV/0!", "#VALUE!"][style % 3]}</v></c>`),
          FORMAT_IDS.map((_, style) => `<c s="${style}" t="str"><v>formula text ${style}</v></c>`),
        ]
          .map((row, index) => `<row r="${index + 1}">${row.join("")}</row>`)
          .join("") +
        "</sheetData></worksheet>",
    })
  );

test("cells are formatted one at a time exactly as SheetJS formats them while it parses", async () => {
  for (const date1904 of [false, true]) {
    const bytes = formattedWorkbook({ date1904 });
    // SheetJS formatting every cell itself, over the uploaded ZIP.
    const eager = workbookToPages(
      XLSX.read(bytes, {
        cellDates: false,
        cellFormula: false,
        cellHTML: false,
        cellNF: false,
        cellStyles: false,
        cellText: true,
        dense: true,
        sheetStubs: false,
        type: "buffer",
      })
    );
    const pages = await extractXlsxPages(bytes);

    assert.deepStrictEqual(pages, eager, `date1904 ${date1904}`);
    // An implicit format (44, accounting) and a custom one are applied.
    assert.match(pages[0].text, /\$ *\(1,234\.57\)/);
    assert.match(pages[0].text, /Total: 45,306\.75/);
  }
});

test("the implicit number formats are the ones the installed SheetJS loads", () => {
  // Every id a cell format names without a numFmt, read back from SheetJS's
  // own table after it formatted those cells.
  const ids = Array.from({ length: 0x189 }, (_, id) => id);
  const container = XLSX.CFB.utils.cfb_new();
  const add = (name, text) => XLSX.CFB.utils.cfb_add(container, name, Buffer.from(text));

  add(
    "[Content_Types].xml",
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/>` +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'
  );
  add("xl/workbook.xml", `${XML_DECLARATION}<workbook ${S_NS} xmlns:r="${REL}"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  add(
    "xl/_rels/workbook.xml.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
  );
  add("xl/styles.xml", `${XML_DECLARATION}<styleSheet ${S_NS}><cellXfs>${ids.map((id) => `<xf numFmtId="${id}"/>`).join("")}</cellXfs></styleSheet>`);
  add(
    "xl/worksheets/sheet1.xml",
    `${XML_DECLARATION}<worksheet ${S_NS}><sheetData>${ids.map((id) => `<row r="${id + 1}"><c s="${id}"><v>1</v></c></row>`).join("")}</sheetData></worksheet>`
  );

  const zip = XLSX.CFB.write(container, { compression: false, fileType: "zip", type: "buffer" });
  const unformatted = XLSX.read(zip, { cellText: false, dense: true, type: "buffer" }).SSF;
  const formatted = XLSX.read(zip, { cellText: true, dense: true, type: "buffer" }).SSF;
  const loaded = Object.fromEntries(
    ids.filter((id) => unformatted[id] === undefined && formatted[id] !== undefined && formatted[id] !== "General").map((id) => [id, formatted[id]])
  );

  assert.deepEqual(SHEETJS_IMPLICIT_NUMBER_FORMATS, loaded);
});

test("the text budget: the cells' raw text as it is read, the lines as they are written; 413 past it", async () => {
  // One long shared string referenced by many cells.
  const text = "word ".repeat(2_000);
  const bytes = buildXlsx({ sheets: [{ name: "Repeat", rows: Array.from({ length: 30 }, () => [text]) }] });
  const pages = await extractXlsxPages(bytes);
  const total = pages[0].text.length;

  assert.equal(pages[0].text.split("\n").length, 31);
  assert.deepEqual(await extractXlsxPages(bytes, { maxTextChars: total + 31 }), pages);
  await expectRefusal(extractXlsxPages(bytes, { maxTextChars: 30_000 }), { code: CODES.archiveTooLarge, status: 413 });

  // Whitespace counts while it is read, though it collapses.
  const blank = buildXlsx({ sheets: [{ name: "Blank", rows: [["x", " ".repeat(5_000)]] }] });

  await expectRefusal(extractXlsxPages(blank, { maxTextChars: 1_000 }), { code: CODES.archiveTooLarge, status: 413 });
});

test("a package SheetJS would read as another spreadsheet format is refused", async () => {
  for (const part of ["META-INF/manifest.xml", "objectdata.xml", "Index/Document.iwa"]) {
    const bytes = buildZip([...xlsxEntries({ sheets: [{ name: "A", rows: [["x"]] }] }), { data: "<manifest/>", name: part }]);

    await expectRefusal(extractXlsxPages(bytes), { code: CODES.archiveInvalid, status: 400 });
  }
});

test("a workbook part, shared strings or styles over RAG_OFFICE_MAX_XML_BYTES is refused; worksheets are not", async () => {
  const bytes = buildXlsx({ sheets: [{ name: "A", rows: [["x", "y"], ["z", 1], ...numberRows(200)] }] });
  const { partSizes } = await scanOfficeArchive(bytes);
  const sizeOf = (name) => partSizes.get(name.toLowerCase());
  const largestBounded = Math.max(
    ...["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml", "xl/styles.xml"].map(sizeOf)
  );

  assert.ok(sizeOf("xl/worksheets/sheet1.xml") > largestBounded, "the worksheet is the largest part");
  assert.equal((await extractXlsxPages(bytes, { maxXmlBytes: largestBounded })).length, 1);

  for (const name of ["xl/workbook.xml", "xl/sharedStrings.xml", "xl/styles.xml"]) {
    await expectRefusal(extractXlsxPages(bytes, { maxXmlBytes: sizeOf(name) - 1 }), { code: CODES.archiveTooLarge, status: 413 });
  }
});

test("a workbook SheetJS cannot read is 400 DOCUMENT_ARCHIVE_INVALID", async () => {
  const broken = buildZip(xlsxEntries({ sheets: [{ name: "A", rows: [["x"]] }] }).filter((entry) => entry.name !== "xl/workbook.xml"));
  const foreignNamespace = buildXlsx({
    sheets: [{ name: "A", rows: [["x"]] }],
    transform: (entries) =>
      replacePart(entries, "xl/workbook.xml", `${XML_DECLARATION}<workbook xmlns="urn:other"><sheets/></workbook>`),
  });

  await expectRefusal(extractXlsxPages(broken), { code: CODES.archiveInvalid, status: 400 });
  await expectRefusal(extractXlsxPages(foreignNamespace), { code: CODES.archiveInvalid, status: 400 });
});

test("parsing twice gives the same pages, and every visible word reaches them", async () => {
  assert.deepEqual(await extractXlsxPages(SALES), await extractXlsxPages(SALES));

  const pageWords = new Set(words((await extractXlsxPages(SALES)).map((page) => page.text).join("\n")).map((word) => word.toLowerCase()));
  const visible = ["Sales", "Notes", "Quarterly sales report", "Prepared by finance", "Region Units Revenue Closed on Share"]
    .concat(["North South Total late", "Remember the audit", "Second note line"])
    .join(" ");

  assert.deepEqual(
    words(visible).filter((word) => !pageWords.has(word.toLowerCase())),
    []
  );
});

test("the extractor and its version are the installed SheetJS's", () => {
  const packageJson = JSON.parse(
    readFileSync(fileURLToPath(new URL("../node_modules/xlsx/package.json", import.meta.url)), "utf8")
  );

  assert.equal(XLSX_EXTRACTOR, "sheetjs");
  assert.equal(getSheetjsVersion(), packageJson.version);
});
