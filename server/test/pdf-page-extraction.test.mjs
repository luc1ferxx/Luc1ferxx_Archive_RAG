// pdf.js page extraction (rag/pdf-page-extraction.js) and the in-process
// document parse built on it (rag/pdfjs-document.js): the page text must be
// exactly what rag/pdf-loader.js produced before the extraction moved out of
// it, and the page signals PDF_PARSER=auto routes on must describe text,
// tables and images the way their contract says.
import "../rag/pdf-runtime-shim.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDocument, OPS, version as pdfJsVersion, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";

import { loadPdfDocument } from "../rag/pdf-loader.js";
import {
  countPdfPages,
  extractPdfPageRange,
  isTableCaptionLine,
  measureGarbledCharRatio,
  measurePageImages,
  measurePageText,
  renderExtractedPages,
  restorePdfjsError,
} from "../rag/pdf-page-extraction.js";
import {
  buildHyphenationVocabulary,
  buildPdfTextLines,
  renderPdfParagraphText,
} from "../rag/pdf-paragraphs.js";
import { parsePdfBytesWithPdfjs } from "../rag/pdfjs-document.js";
import {
  buildMixedPdf,
  buildPdf,
  buildProsePdf,
  formXObject,
  GREY_IMAGE,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  textLines,
} from "./pdf-fixture-builder.mjs";

// ---------------------------------------------------------------------------
// rag/pdf-loader.js's loadPdfDocument as it was before the extraction moved
// into rag/pdf-page-extraction.js, frozen here (reading bytes instead of a
// file) as the reference the refactored path must match byte for byte.

const frozenNormalizePageText = (text = "") =>
  String(text)
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .replace(/-\n(?=[a-z])/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const frozenReadPdfPageTextContent = (pageData) =>
  pageData.getTextContent({
    disableNormalization: false,
  });

const frozenRenderPdfPageText = async (pageData) => {
  const textContent = await frozenReadPdfPageTextContent(pageData);
  let text = "";
  let lastY = null;

  for (const item of textContent.items) {
    const y = item.transform?.[5];
    const value = item.str ?? "";

    if (!value) {
      continue;
    }

    if (lastY === null || lastY === y) {
      text += value;
    } else {
      text += `\n${value}`;
    }

    lastY = y;
  }

  return text;
};

const frozenResolvePageLimit = ({ maxPages, pageCount }) => {
  if (maxPages === undefined || maxPages === null || maxPages === 0) {
    return pageCount;
  }

  if (!Number.isInteger(maxPages) || maxPages < 0) {
    throw new TypeError("maxPages must be a non-negative integer.");
  }

  return Math.min(maxPages, pageCount);
};

const frozenLoadPdfDocument = async (dataBuffer, { maxPages = 0, includeMetadata = false, paragraphDetection }) => {
  const pages = [];
  const pageLines = [];
  let pageCount = 0;
  let info = null;
  const loadingTask = getDocument({
    data: new Uint8Array(dataBuffer),
    isEvalSupported: false,
    verbosity: VerbosityLevel.ERRORS,
  });

  try {
    const document = await loadingTask.promise;
    pageCount = document.numPages;
    const renderedPageCount = frozenResolvePageLimit({
      maxPages,
      pageCount,
    });

    for (let pageNumber = 1; pageNumber <= renderedPageCount; pageNumber += 1) {
      const pageData = await document.getPage(pageNumber);

      try {
        if (paragraphDetection) {
          const textContent = await frozenReadPdfPageTextContent(pageData);
          pageLines.push(buildPdfTextLines(textContent.items));
          pages.push({ pageNumber, text: "" });
        } else {
          const text = await frozenRenderPdfPageText(pageData);
          pages.push({
            pageNumber,
            text: frozenNormalizePageText(text),
          });
        }
      } finally {
        pageData.cleanup();
      }
    }

    if (paragraphDetection) {
      const vocabulary = buildHyphenationVocabulary(pageLines);
      pages.forEach((page, index) => {
        page.text = renderPdfParagraphText(pageLines[index], { vocabulary });
      });
    }

    if (includeMetadata) {
      const metadata = await document.getMetadata();
      info = metadata.info ?? null;
    }
  } finally {
    await loadingTask.destroy();
  }

  return {
    pages,
    pageCount,
    renderedPageCount: pages.length,
    pdfVersion: pdfJsVersion,
    info,
  };
};

// ---------------------------------------------------------------------------

const withTempPdf = async (t, bytes) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pdf-page-extraction-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const filePath = path.join(directory, "document.pdf");
  await writeFile(filePath, bytes);
  return filePath;
};

test("parsePdfBytesWithPdfjs in process is the pre-refactor loadPdfDocument, byte for byte", async () => {
  for (const bytes of [buildProsePdf(), buildMixedPdf()]) {
    for (const paragraphDetection of [true, false]) {
      for (const options of [{}, { includeMetadata: true }, { includeMetadata: true, maxPages: 3 }, { maxPages: 99 }]) {
        const expected = await frozenLoadPdfDocument(bytes, { ...options, paragraphDetection });
        const actual = await parsePdfBytesWithPdfjs(bytes, { ...options, paragraphDetection, workers: 0 });

        assert.deepStrictEqual(actual, expected, JSON.stringify({ options, paragraphDetection }));

        // Signals ride along without changing a byte of the pages.
        const withSignals = await parsePdfBytesWithPdfjs(bytes, {
          ...options,
          collectSignals: true,
          paragraphDetection,
          workers: 0,
        });
        const { signals, ...rest } = withSignals;

        assert.deepStrictEqual(rest, expected);
        assert.deepStrictEqual(
          signals.map(({ pageNumber }) => pageNumber),
          expected.pages.map(({ pageNumber }) => pageNumber)
        );
      }
    }
  }
});

test("loadPdfDocument reads the file and returns the frozen result, signals only when asked", async (t) => {
  const bytes = buildProsePdf();
  const filePath = await withTempPdf(t, bytes);

  for (const paragraphDetection of [true, false]) {
    const expected = await frozenLoadPdfDocument(bytes, { includeMetadata: true, paragraphDetection });
    const actual = await loadPdfDocument(filePath, { includeMetadata: true, paragraphDetection, workers: 0 });

    assert.deepStrictEqual(actual, expected);
    assert.equal(Object.hasOwn(actual, "signals"), false);
  }

  const withSignals = await loadPdfDocument(filePath, { collectSignals: true, workers: 0 });

  assert.equal(withSignals.signals.length, 7);
  assert.equal(withSignals.info, null);
});

test("an invalid maxPages and a malformed PDF fail as before", async () => {
  const bytes = buildProsePdf();

  for (const maxPages of [-1, 1.5]) {
    await assert.rejects(parsePdfBytesWithPdfjs(bytes, { maxPages, workers: 0 }), {
      message: "maxPages must be a non-negative integer.",
      name: "TypeError",
    });
  }

  const malformed = Buffer.from("%PDF-1.4\nnot-a-document\n%%EOF\n");
  const expected = await frozenLoadPdfDocument(malformed, { paragraphDetection: true }).catch((error) => error);
  const actual = await parsePdfBytesWithPdfjs(malformed, { workers: 0 }).catch((error) => error);

  assert.equal(actual.constructor, expected.constructor);
  assert.equal(actual.name, expected.name);
  assert.equal(actual.message, expected.message);
});

test("the caller's bytes are neither detached nor changed", async () => {
  const bytes = buildProsePdf();
  const copy = Buffer.from(bytes);

  await parsePdfBytesWithPdfjs(bytes, { collectSignals: true, workers: 0 });
  await extractPdfPageRange(bytes, { firstPage: 2, lastPage: 3 });
  await countPdfPages(bytes);

  assert.equal(bytes.byteLength, copy.byteLength);
  assert.ok(bytes.equals(copy));
});

test("extractPdfPageRange reads only its range and reports the whole document's page count", async () => {
  const bytes = buildProsePdf();
  const whole = await extractPdfPageRange(bytes, { paragraphDetection: false });

  assert.equal(whole.pageCount, 7);
  assert.equal(whole.pdfVersion, pdfJsVersion);
  assert.equal(whole.info, null);

  const middle = await extractPdfPageRange(bytes, { firstPage: 3, lastPage: 4, paragraphDetection: false });

  assert.equal(middle.pageCount, 7);
  assert.deepStrictEqual(middle.pages, whole.pages.slice(2, 4));

  const capped = await extractPdfPageRange(bytes, { firstPage: 2, maxPages: 3, paragraphDetection: true });

  assert.deepStrictEqual(
    capped.pages.map(({ pageNumber }) => pageNumber),
    [2, 3]
  );
  assert.ok(Array.isArray(capped.pages[0].lines));
  assert.equal(Object.hasOwn(capped.pages[0], "text"), false);
  assert.equal(Object.hasOwn(capped.pages[0], "signals"), false);

  assert.deepStrictEqual((await extractPdfPageRange(bytes, { firstPage: 9 })).pages, []);
  assert.equal((await extractPdfPageRange(bytes, { includeMetadata: true, lastPage: 1 })).info.Title, "Range parity sample");
  await assert.rejects(extractPdfPageRange(bytes, { firstPage: 0 }), TypeError);
  await assert.rejects(extractPdfPageRange(bytes, { firstPage: 1, lastPage: 1.5 }), TypeError);
  assert.equal(await countPdfPages(bytes), 7);
});

test("renderExtractedPages judges a line-end hyphen against every page it is given", async () => {
  const bytes = buildProsePdf();
  const { pages } = await extractPdfPageRange(bytes, { paragraphDetection: true });
  const rendered = renderExtractedPages(pages, { paragraphDetection: true });

  // Page 5 spells "follow-up", so page 1's "follow-" / "up" keeps its hyphen;
  // nothing spells "informa-tion", so that one goes.
  assert.match(rendered[0].text, /A follow-up review/);
  assert.match(rendered[0].text, /The information they handle/);
  assert.match(renderExtractedPages(pages.slice(0, 1), { paragraphDetection: true })[0].text, /A followup review/);

  const legacy = await extractPdfPageRange(bytes, { paragraphDetection: false });

  assert.deepStrictEqual(
    renderExtractedPages(legacy.pages, { paragraphDetection: false }),
    legacy.pages.map(({ pageNumber, text }) => ({ pageNumber, text }))
  );
});

// ---------------------------------------------------------------------------
// Signals

const signalsOf = async (bytes) => (await parsePdfBytesWithPdfjs(bytes, { collectSignals: true, workers: 0 })).signals;

test("signals of a plain text page, a table page, a full-page image, a small figure and a garbled text layer", async () => {
  const [prose, table, scan, figure, garbled] = await signalsOf(buildMixedPdf());

  assert.deepStrictEqual(prose, {
    pageNumber: 1,
    charCount: [
      "Quarterly report",
      "Revenue grew in every region except the north, where a new",
      "competitor opened two stores. The board approved the re-",
      "structuring plan in March.",
    ].join("").replace(/\s/g, "").length,
    itemCount: 4,
    lineCount: 4,
    tabularLineCount: 0,
    tableCaption: false,
    imageCount: 0,
    imageCoverage: 0,
    garbledCharRatio: 0,
  });

  // Header and two rows; the two equation lines are tabular (a wide gap
  // before the number) but end in "(3)" and "(4a)", so they do not count.
  assert.equal(table.lineCount, 6);
  assert.equal(table.tabularLineCount, 3);
  assert.equal(table.tableCaption, true);
  assert.equal(table.imageCount, 0);

  assert.equal(scan.charCount, 0);
  assert.equal(scan.itemCount, 0);
  assert.equal(scan.lineCount, 0);
  assert.equal(scan.imageCount, 1);
  assert.equal(scan.imageCoverage, 1);

  assert.equal(figure.imageCount, 1);
  assert.ok(Math.abs(figure.imageCoverage - 0.01) < 1e-9, String(figure.imageCoverage));
  assert.equal(figure.lineCount, 1);

  // "ABCDE" twice through the garbled font (four private-use code points and
  // U+FFFD each), then "plain".
  assert.equal(garbled.charCount, 15);
  assert.ok(Math.abs(garbled.garbledCharRatio - 10 / 15) < 1e-9, String(garbled.garbledCharRatio));
});

test("image coverage follows save/restore, cm, form matrices and group forms, clipped to the page", async () => {
  const signals = await signalsOf(
    buildPdf({
      pages: [
        // Nested q/cm/Q around a form: 2 x 0.5 = 1, so the form's half-page
        // image covers a quarter of the page.
        "q 2 0 0 2 0 0 cm q 0.5 0 0 0.5 0 0 cm /Fm1 Do Q Q",
        // A transparency group form whose /Matrix halves a full-page image:
        // applied once, a quarter of the page (twice would be a sixteenth).
        "/Fm2 Do",
        // Restore really restores: the second image is painted at identity.
        "q 612 0 0 792 0 0 cm Q /Im1 Do",
        // An image twice the page, centred: clipped to exactly the page.
        "q 1224 0 0 1584 -306 -396 cm /Im1 Do Q",
        // Four tiles of 1% each. (pdf.js may merge such runs into one repeat
        // operator; the next test covers those operators directly.)
        [0, 100, 200, 300].map((x) => `q 61.2 0 0 79.2 ${x} 0 cm /Im1 Do Q`).join(" "),
        // Inline images: one at identity, one stretched over the page.
        "BI /W 2 /H 2 /CS /G /BPC 8 /F /AHx ID 00FFFF00> EI q 612 0 0 792 0 0 cm BI /W 2 /H 2 /CS /G /BPC 8 /F /AHx ID 00FFFF00> EI Q",
        // Off the page entirely.
        "q 100 0 0 100 700 900 cm /Im1 Do Q",
      ],
      xobjects: {
        Im1: GREY_IMAGE,
        Fm1: formXObject("q 306 0 0 396 0 0 cm /Im1 Do Q", { xobjects: ["Im1"] }),
        Fm2: formXObject("q 612 0 0 792 0 0 cm /Im1 Do Q", { group: true, matrix: [0.5, 0, 0, 0.5, 0, 0], xobjects: ["Im1"] }),
      },
    })
  );
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} vs ${expected}`);

  near(signals[0].imageCoverage, 0.25);
  near(signals[1].imageCoverage, 0.25);
  near(signals[2].imageCoverage, 1 / (PAGE_WIDTH * PAGE_HEIGHT));
  near(signals[3].imageCoverage, 1);
  near(signals[4].imageCoverage, 0.04);
  assert.equal(signals[4].imageCount, 4);
  assert.equal(signals[5].imageCount, 2);
  near(signals[5].imageCoverage, 1);
  assert.equal(signals[6].imageCount, 1);
  assert.equal(signals[6].imageCoverage, 0);
  assert.ok(signals.every((page) => page.charCount === 0 && page.garbledCharRatio === 0));
});

test("measurePageImages reads every image paint operator, the merged repeat and group ones included", () => {
  const view = [0, 0, 100, 100];
  const measure = (fnArray, argsArray) => measurePageImages({ argsArray, fnArray }, view);

  assert.deepStrictEqual(measure([], []), { imageCount: 0, imageCoverage: 0 });
  // A unit square at identity on a 100 x 100 page.
  assert.deepStrictEqual(measure([OPS.paintImageXObject], [["img_1", 2, 2]]), { imageCount: 1, imageCoverage: 0.0001 });
  assert.deepStrictEqual(
    measure([OPS.transform, OPS.paintSolidColorImageMask], [[10, 0, 0, 10, 0, 0], []]),
    { imageCount: 1, imageCoverage: 0.01 }
  );
  assert.deepStrictEqual(
    measure([OPS.transform, OPS.paintImageMaskXObject], [[50, 0, 0, 20, 0, 0], [{ data: "mask_1" }]]),
    { imageCount: 1, imageCoverage: 0.1 }
  );
  assert.deepStrictEqual(
    measure([OPS.paintImageXObjectRepeat], [["img_1", 10, 20, new Float32Array([0, 0, 50, 50, 95, 95])]]),
    // The third tile hangs off the corner: 5 x 5 of it is on the page.
    { imageCount: 3, imageCoverage: (200 + 200 + 25) / 10000 }
  );
  assert.deepStrictEqual(
    measure([OPS.paintImageMaskXObjectRepeat], [[{ data: "mask_1" }, 10, 0, 0, 10, new Float32Array([0, 0, 20, 20])]]),
    { imageCount: 2, imageCoverage: 0.02 }
  );
  assert.deepStrictEqual(
    measure(
      [OPS.paintImageMaskXObjectGroup],
      [[[{ transform: [10, 0, 0, 10, 0, 0] }, { transform: [30, 0, 0, 10, 50, 50] }]]]
    ),
    { imageCount: 2, imageCoverage: 0.04 }
  );
  assert.deepStrictEqual(
    measure([OPS.save, OPS.transform, OPS.paintInlineImageXObjectGroup, OPS.restore], [
      [],
      [2, 0, 0, 2, 0, 0],
      [{ width: 4, height: 4 }, [{ transform: [10, 0, 0, 10, 0, 0] }, { transform: [5, 0, 0, 5, 20, 0] }]],
      [],
    ]),
    { imageCount: 2, imageCoverage: (400 + 100) / 10000 }
  );
  // A rotated square counts by its bounding box; overlaps are summed and the
  // total is capped at the page.
  assert.deepStrictEqual(
    measure([OPS.transform, OPS.paintImageXObject], [[0, 10, -10, 0, 10, 0], ["img_1", 2, 2]]),
    { imageCount: 1, imageCoverage: 0.01 }
  );
  assert.deepStrictEqual(
    measure(
      [OPS.transform, OPS.paintImageXObject, OPS.paintImageXObject],
      [[80, 0, 0, 80, 0, 0], ["img_1", 2, 2], ["img_1", 2, 2]]
    ),
    { imageCount: 2, imageCoverage: 1 }
  );
  // A form begin/end and a group save and restore; an unbalanced restore
  // keeps the matrix in force.
  assert.deepStrictEqual(
    measure(
      [OPS.beginGroup, OPS.paintFormXObjectBegin, OPS.paintImageXObject, OPS.paintFormXObjectEnd, OPS.endGroup, OPS.restore, OPS.paintImageXObject],
      [[{ matrix: [10, 0, 0, 10, 0, 0] }], [new Float32Array([10, 0, 0, 10, 0, 0]), null], ["img_1"], [], [{}], [], ["img_2"]]
    ),
    { imageCount: 2, imageCoverage: (100 + 1) / 10000 }
  );
  // An empty page box gives no coverage.
  assert.deepStrictEqual(
    measurePageImages({ argsArray: [["img_1"]], fnArray: [OPS.paintImageXObject] }, [0, 0, 0, 0]),
    { imageCount: 1, imageCoverage: 0 }
  );
});

test("the garbled share counts U+FFFD, private use and controls over non-whitespace characters", () => {
  assert.equal(measureGarbledCharRatio(""), 0);
  assert.equal(measureGarbledCharRatio("   \n\t"), 0);
  assert.equal(measureGarbledCharRatio("abc�"), 0.25);
  assert.equal(measureGarbledCharRatio("a b  "), 0.5);
  assert.equal(measureGarbledCharRatio("\u{F0000}\u{10FFFD}ab"), 0.5);
  assert.equal(measureGarbledCharRatio("\u0001\u001F\u007F\u0085\u009Fabcde"), 0.5);
  // Whitespace controls are whitespace, not garbled characters.
  assert.equal(measureGarbledCharRatio("ab\tcd\n"), 0);
  assert.equal(measureGarbledCharRatio(""), 1);
  // Ordinary non-Latin text and symbols are not garbled.
  assert.equal(measureGarbledCharRatio("租赁合同 ≤ 5 €"), 0);

  const items = [
    { str: "ab\u0000", transform: [12, 0, 0, 12, 72, 700] },
    { str: "", transform: [12, 0, 0, 12, 90, 700] },
    { str: "  ", transform: [12, 0, 0, 12, 100, 700] },
  ];
  const text = measurePageText(items);

  // \u0000 is removed before counting, as buildPdfTextLines removes it.
  assert.equal(text.charCount, 3);
  assert.equal(text.itemCount, 2);
  assert.equal(text.lineCount, 1);
  assert.equal(text.garbledCharRatio, 1 / 3);
  assert.equal(measurePageText([]).garbledCharRatio, 0);
});

test("table captions in English and Chinese, and words that only start like one", () => {
  for (const line of ["Table 1: Leave", "TABLE IV Results", "Tab. 2 Scores", "Table3 shows", "表 3 结果", "表二：费用", "  Table 12"]) {
    assert.equal(isTableCaptionLine(line), true, line);
  }

  for (const line of ["Tablet 1", "Tables show", "The table 1", "Table of contents", "表格", "Tab 2"]) {
    assert.equal(isTableCaptionLine(line), false, line);
  }
});

test("without collectSignals no operator list is read", async (t) => {
  const bytes = buildProsePdf();
  const loadingTask = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: VerbosityLevel.ERRORS });
  const page = await (await loadingTask.promise).getPage(1);
  const prototype = Object.getPrototypeOf(page);
  const original = prototype.getOperatorList;
  let calls = 0;

  await loadingTask.destroy();
  prototype.getOperatorList = function countedGetOperatorList(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  t.after(() => {
    prototype.getOperatorList = original;
  });

  await parsePdfBytesWithPdfjs(bytes, { workers: 0 });
  await parsePdfBytesWithPdfjs(bytes, { paragraphDetection: false, workers: 0 });
  assert.equal(calls, 0);

  await parsePdfBytesWithPdfjs(bytes, { collectSignals: true, workers: 0 });
  assert.equal(calls, 7);
});

test("restorePdfjsError turns a worker's pdf.js exception back into its class", async () => {
  const malformed = Buffer.from("%PDF-1.4\nnot-a-document\n%%EOF\n");
  const original = await countPdfPages(malformed).catch((error) => error);
  const crossed = Object.assign(new Error(original.message), { name: original.name });
  const restored = restorePdfjsError(crossed);

  assert.equal(restored.constructor, original.constructor);
  assert.equal(restored.message, original.message);
  assert.equal(restored.name, "InvalidPDFException");
  assert.equal(restorePdfjsError(original), original);

  const password = restorePdfjsError(Object.assign(new Error("No password given"), { code: 1, name: "PasswordException" }));

  assert.equal(password.name, "PasswordException");
  assert.equal(password.code, 1);

  const other = new TypeError("x");

  assert.equal(restorePdfjsError(other), other);
});
