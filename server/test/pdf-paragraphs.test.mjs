import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPdfDocument, loadPdfPages } from "../rag/pdf-loader.js";
import {
  buildPdfTextLines,
  renderPdfParagraphText,
  shouldDropLineEndHyphen,
} from "../rag/pdf-paragraphs.js";
import { isPdfParagraphDetectionEnabled } from "../rag/config.js";

const escapePdfText = (text) =>
  text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

// Each line is { x, y, text, size = 11, font = "F1", cells }: cells are extra
// runs on the same baseline, moved right with Td (a table-like row).
const buildPositionedPdfBuffer = (pages) => {
  const fonts = [
    { name: "F1", baseFont: "Helvetica" },
    { name: "F2", baseFont: "Helvetica-Bold" },
  ];
  const fontObjectIds = fonts.map((_, index) => 3 + index);
  const firstPageId = 3 + fonts.length;
  const pageObjectIds = pages.map((_, index) => firstPageId + index * 2);
  const contentObjectIds = pages.map((_, index) => firstPageId + 1 + index * 2);
  const objects = [
    { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    {
      id: 2,
      body: `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    },
    ...fonts.map((font, index) => ({
      id: fontObjectIds[index],
      body: `<< /Type /Font /Subtype /Type1 /BaseFont /${font.baseFont} >>`,
    })),
  ];
  const fontResources = fonts
    .map((font, index) => `/${font.name} ${fontObjectIds[index]} 0 R`)
    .join(" ");

  pages.forEach((lines, index) => {
    const stream = lines
      .map(({ x, y, text, size = 11, font = "F1", cells = [] }) =>
        [
          "BT",
          `/${font} ${size} Tf`,
          `${x} ${y} Td`,
          `(${escapePdfText(text)}) Tj`,
          ...cells.flatMap((cell) => [`${cell.dx} 0 Td`, `(${escapePdfText(cell.text)}) Tj`]),
          "ET",
        ].join("\n")
      )
      .join("\n");

    objects.push({
      id: pageObjectIds[index],
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjectIds[index]} 0 R /Resources << /Font << ${fontResources} >> >> >>`,
    });
    objects.push({
      id: contentObjectIds[index],
      body: `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
    });
  });

  objects.sort((left, right) => left.id - right.id);
  let pdf = "%PDF-1.4\n";
  const offsets = new Map();

  for (const entry of objects) {
    offsets.set(entry.id, Buffer.byteLength(pdf, "utf8"));
    pdf += `${entry.id} 0 obj\n${entry.body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;

  for (const entry of objects) {
    pdf += `${String(offsets.get(entry.id)).padStart(10, "0")} 00000 n \n`;
  }

  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
};

const POLICY_PAGES = [
  [
    { x: 72, y: 740, text: "Remote Work Policy", size: 16, font: "F2" },
    { x: 90, y: 712, text: "Employees may work remotely for up to three days" },
    { x: 72, y: 698, text: "each week when their manager approves the arrange-" },
    { x: 72, y: 684, text: "ment in writing before the first remote day. The" },
    { x: 72, y: 670, text: "program uses a state-of-the-" },
    { x: 72, y: 656, text: "art scheduling tool and a short follow-" },
    { x: 72, y: 642, text: "up survey signed by" },
    { x: 72, y: 628, text: "Human Resources each quarter." },
    { x: 90, y: 600, text: "Every follow-up is logged by the team lead and" },
    { x: 72, y: 586, text: "reviewed monthly." },
    { x: 90, y: 572, text: "Remote days cannot be carried over to the next" },
    { x: 72, y: 558, text: "month." },
    { x: 72, y: 530, text: "Eligibility", font: "F2" },
    { x: 72, y: 516, text: "1. Completed probation period" },
    { x: 72, y: 502, text: "2. Signed equipment agreement" },
    { x: 84, y: 488, text: "covering the company laptop" },
    { x: 72, y: 474, text: "a) remote days are logged in the portal" },
    { x: 72, y: 446, text: "Approver:" },
    { x: 72, y: 432, text: "the line manager" },
    { x: 72, y: 418, text: "Fee: 100 per month" },
    { x: 72, y: 404, text: "Term: 12 months" },
    { x: 72, y: 376, text: "Location", cells: [{ dx: 228, text: "Days per week" }] },
    { x: 72, y: 362, text: "Office", cells: [{ dx: 228, text: "2" }] },
    { x: 72, y: 348, text: "Home", cells: [{ dx: 228, text: "3" }] },
  ],
  [
    { x: 72, y: 740, text: "Second page text that wraps onto" },
    { x: 72, y: 726, text: "a second line." },
  ],
];

// The legacy pdf.js page text of POLICY_PAGES, byte for byte as the loader
// produced it before paragraph detection existed (one "\n" per baseline
// change, every line-end hyphen before a lowercase letter removed).
const LEGACY_PAGE_ONE = [
  "Remote Work Policy",
  "Employees may work remotely for up to three days",
  "each week when their manager approves the arrangement in writing before the first remote day. The",
  "program uses a state-of-theart scheduling tool and a short followup survey signed by",
  "Human Resources each quarter.",
  "Every follow-up is logged by the team lead and",
  "reviewed monthly.",
  "Remote days cannot be carried over to the next",
  "month.",
  "Eligibility",
  "1. Completed probation period",
  "2. Signed equipment agreement",
  "covering the company laptop",
  "a) remote days are logged in the portal",
  "Approver:",
  "the line manager",
  "Fee: 100 per month",
  "Term: 12 months",
  "Location Days per week",
  "Office 2",
  "Home 3",
];

const withPositionedPdf = async (pages, callback) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pdf-paragraphs-"));
  const pdfPath = path.join(tempDir, "policy.pdf");

  try {
    await writeFile(pdfPath, buildPositionedPdfBuffer(pages));
    return await callback(pdfPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

const withPolicyPdf = (callback) => withPositionedPdf(POLICY_PAGES, callback);

const withEnv = async (name, value, callback) => {
  const previous = process.env[name];

  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
};

const nonWhitespace = (text) => text.replace(/\s+/g, "");

// True when `reduced` is `full` with nothing but some "-" characters removed.
const isFullMinusHyphens = (full, reduced) => {
  let index = 0;

  for (const character of full) {
    if (character === reduced[index]) {
      index += 1;
    } else if (character !== "-") {
      return false;
    }
  }

  return index === reduced.length;
};

const rawLineText = (pages) =>
  pages.map((lines) =>
    lines.map((line) => [line.text, ...(line.cells ?? []).map((cell) => cell.text)].join("")).join("")
  );

test("paragraph detection is on by default", async () => {
  await withEnv("PDF_PARAGRAPH_DETECTION", undefined, async () => {
    assert.equal(isPdfParagraphDetectionEnabled(), true);

    await withPolicyPdf(async (pdfPath) => {
      const pages = await loadPdfPages(pdfPath);
      const explicitOn = await loadPdfDocument(pdfPath, { paragraphDetection: true });

      assert.deepEqual(pages, explicitOn.pages);
      assert.equal(pages[1].text, "Second page text that wraps onto a second line.");
    });
  });
});

test("PDF_PARAGRAPH_DETECTION=false keeps the legacy page text unchanged", async () => {
  await withEnv("PDF_PARAGRAPH_DETECTION", "false", async () => {
    assert.equal(isPdfParagraphDetectionEnabled(), false);

    await withPolicyPdf(async (pdfPath) => {
      const pages = await loadPdfPages(pdfPath);
      const explicitOff = await loadPdfDocument(pdfPath, { paragraphDetection: false });

      assert.deepEqual(pages, explicitOff.pages);
      assert.equal(pages.length, 2);
      assert.equal(pages[0].pageNumber, 1);
      assert.equal(pages[1].pageNumber, 2);
      assert.equal(pages[0].text, LEGACY_PAGE_ONE.join("\n"));
      assert.equal(pages[1].text, "Second page text that wraps onto\na second line.");
    });
  });
});

test("paragraph detection rejoins wrapped lines and keeps headings, list items, labels and table rows apart", async () => {
  await withEnv("PDF_PARAGRAPH_DETECTION", "true", async () => {
    assert.equal(isPdfParagraphDetectionEnabled(), true);

    await withPolicyPdf(async (pdfPath) => {
      const pages = await loadPdfPages(pdfPath);
      const [pageOne, pageTwo] = pages;
      const paragraphs = pageOne.text.split("\n\n");

      assert.deepEqual(
        pages.map((page) => page.pageNumber),
        [1, 2]
      );
      assert.deepEqual(Object.keys(pageOne), ["pageNumber", "text"]);

      // Heading (bigger bold font) is its own paragraph.
      assert.equal(paragraphs[0], "Remote Work Policy");
      // Soft wraps rejoined; "arrange-/ment" loses its hyphen, the compound
      // "state-of-the-/art" and "follow-/up" (spelled hyphenated elsewhere in
      // the document) keep theirs; "signed by" / "Human Resources" is not a
      // lowercase continuation and stays on its own line.
      assert.equal(
        paragraphs[1],
        "Employees may work remotely for up to three days each week when their manager approves the arrangement in writing before the first remote day. The program uses a state-of-the-art scheduling tool and a short follow-up survey signed by\nHuman Resources each quarter."
      );
      // A larger vertical gap and a first-line indent each start a paragraph.
      assert.equal(paragraphs[2], "Every follow-up is logged by the team lead and reviewed monthly.");
      assert.equal(paragraphs[3], "Remote days cannot be carried over to the next month.");
      // Same-size heading in another font.
      assert.equal(paragraphs[4], "Eligibility");
      // List items are never joined to each other or to the line before; a
      // hanging-indent continuation in lowercase joins its own item.
      assert.equal(paragraphs[5], "1. Completed probation period");
      assert.equal(paragraphs[6], "2. Signed equipment agreement covering the company laptop");
      assert.equal(paragraphs[7], "a) remote days are logged in the portal");

      const lines = pageOne.text.split(/\n+/);

      // Label lines are never joined.
      for (const label of ["Approver:", "the line manager", "Fee: 100 per month", "Term: 12 months"]) {
        assert.ok(lines.includes(label), `${label} stays its own line`);
      }

      // Table-like rows keep one row per line, cells as on the legacy path.
      assert.equal(paragraphs.at(-1), "Location Days per week\nOffice 2\nHome 3");

      assert.equal(pageTwo.text, "Second page text that wraps onto a second line.");
    });
  });
});

test("paragraph detection loses no text: only whitespace and removed line-end hyphens differ", async () => {
  await withPolicyPdf(async (pdfPath) => {
    const on = await loadPdfDocument(pdfPath, { paragraphDetection: true });
    const off = await loadPdfDocument(pdfPath, { paragraphDetection: false });
    const raw = rawLineText(POLICY_PAGES);

    on.pages.forEach((page, index) => {
      assert.ok(
        isFullMinusHyphens(nonWhitespace(raw[index]), nonWhitespace(page.text)),
        `page ${page.pageNumber}: paragraph text is the raw text minus whitespace and hyphens`
      );
      assert.equal(
        nonWhitespace(page.text).replace(/-/g, ""),
        nonWhitespace(off.pages[index].text).replace(/-/g, "")
      );
    });

    // Exactly one hyphen dropped on page one ("arrange-ment"); the legacy
    // path drops three.
    assert.equal(
      nonWhitespace(raw[0]).length - nonWhitespace(on.pages[0].text).length,
      1
    );
    assert.equal(
      nonWhitespace(raw[0]).length - nonWhitespace(off.pages[0].text).length,
      3
    );
  });
});

test("line-end hyphens are dropped only for a word the line break split", () => {
  assert.equal(shouldDropLineEndHyphen("the informa-", "tion we need", new Set()), true);
  assert.equal(shouldDropLineEndHyphen("a state-of-the-", "art tool", new Set()), false);
  assert.equal(shouldDropLineEndHyphen("a GPT-", "based model", new Set()), false);
  assert.equal(shouldDropLineEndHyphen("the 2019-", "style rules", new Set()), false);
  assert.equal(shouldDropLineEndHyphen("a short follow-", "up survey", new Set(["follow-up"])), false);
  assert.equal(
    shouldDropLineEndHyphen("a short follow-", "up survey", new Set(["follow-up", "followup"])),
    true
  );
  assert.equal(shouldDropLineEndHyphen("a dash -", "and more", new Set()), false);
  assert.equal(shouldDropLineEndHyphen("informa-", "Tion", new Set()), false);
});

test("a superscript on a nearby baseline stays on its line", () => {
  const lines = buildPdfTextLines([
    { str: "results improve", transform: [10, 0, 0, 10, 72, 700], width: 70, fontName: "f1" },
    { str: "1", transform: [6, 0, 0, 6, 142.5, 704], width: 3, fontName: "f1" },
    { str: "on every split", transform: [10, 0, 0, 10, 148, 700], width: 60, fontName: "f1" },
    { str: "", transform: [10, 0, 0, 10, 72, 686], width: 0, fontName: "f1" },
    { str: "and every seed.", transform: [10, 0, 0, 10, 72, 686], width: 70, fontName: "f1" },
  ]);

  assert.deepEqual(
    lines.map((line) => [line.text, line.y, line.size]),
    [
      ["results improve1 on every split", 700, 10],
      ["and every seed.", 686, 10],
    ]
  );
});

// Rows that start in lowercase (model names, "w/o ...") pass the soft-wrap
// rule, so without the cell-gap signal the caption and every row were joined
// into one sentence.
test("table rows that start in lowercase are never joined into a sentence", async () => {
  const row = (y, text, first, second) => ({
    x: 72,
    y,
    text,
    cells: [
      { dx: 200, text: first },
      { dx: 100, text: second },
    ],
  });

  await withPositionedPdf(
    [
      [
        { x: 72, y: 700, text: "Scores of each model on the test set" },
        row(686, "model", "accuracy", "recall"),
        row(672, "bert-base", "0.91", "0.88"),
        row(658, "roberta", "0.93", "0.90"),
        row(644, "w/o attention", "0.85", "0.80"),
        { x: 72, y: 616, text: "The scores were averaged over five" },
        { x: 72, y: 602, text: "seeds for every model." },
      ],
    ],
    async (pdfPath) => {
      const { pages } = await loadPdfDocument(pdfPath, { paragraphDetection: true });

      assert.deepEqual(pages[0].text.split(/\n+/), [
        "Scores of each model on the test set",
        "model accuracy recall",
        "bert-base 0.91 0.88",
        "roberta 0.93 0.90",
        "w/o attention 0.85 0.80",
        "The scores were averaged over five seeds for every model.",
      ]);
    }
  );
});

test("a very large page is rendered without re-sorting the page statistics per line", () => {
  const items = [];

  for (let index = 0; index < 4000; index += 1) {
    items.push({
      str: index % 3 === 0 ? "A line that ends a sentence." : "a wrapped line of body text",
      transform: [10, 0, 0, 10, 72, 100000 - index * 12],
      width: index % 3 === 0 ? 140 : 300,
      fontName: "f1",
    });
  }

  const lines = buildPdfTextLines(items);
  const originalSort = Array.prototype.sort;
  let sorts = 0;
  let text;

  Array.prototype.sort = function countedSort(...args) {
    sorts += 1;
    return originalSort.apply(this, args);
  };

  try {
    text = renderPdfParagraphText(lines);
  } finally {
    Array.prototype.sort = originalSort;
  }

  assert.equal(lines.length, 4000);
  assert.equal(text.replace(/\s+/g, ""), items.map((item) => item.str).join("").replace(/\s+/g, ""));
  // One median per statistic and font size, not one per line.
  assert.ok(sorts <= 4, `sorted ${sorts} times`);
});
