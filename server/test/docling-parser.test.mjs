import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  doclingDocumentToPages,
  loadPdfPagesWithDocling,
  probeDoclingServe,
  renderDoclingTable,
  splitDoclingTextByPage,
} from "../rag/docling-parser.js";

const text = (index, label, value, page, extra = {}) => ({
  content_layer: "body",
  label,
  prov: [{ page_no: page }],
  self_ref: `#/texts/${index}`,
  text: value,
  ...extra,
});
const cell = (value, columnHeader = false) => ({ column_header: columnHeader, text: value });

// Two stacked header rows, the second not flagged as header by the model,
// and a spanning top cell repeated across the columns it covers.
const TABLE = {
  captions: [{ $ref: "#/texts/4" }],
  content_layer: "body",
  data: {
    grid: [
      [cell("Model", true), cell("Raw", true), cell("Raw", true)],
      [cell(""), cell("Dev"), cell("Test")],
      [cell("BiLSTM"), cell("81.2"), cell("76.9")],
      [cell("GloVe"), cell("84.0"), cell("80.1")],
    ],
    num_cols: 3,
    num_rows: 4,
  },
  label: "table",
  prov: [{ page_no: 2 }],
};

const DOCUMENT = {
  body: {
    children: [
      { $ref: "#/texts/0" },
      { $ref: "#/texts/1" },
      { $ref: "#/texts/2" },
      { $ref: "#/groups/0" },
      { $ref: "#/tables/0" },
      { $ref: "#/pictures/0" },
      { $ref: "#/texts/5" },
    ],
  },
  groups: [{ children: [{ $ref: "#/texts/3" }], content_layer: "body", label: "list" }],
  pages: { 1: {}, 2: {}, 3: {} },
  pictures: [{ captions: [{ $ref: "#/texts/6" }], content_layer: "body", label: "picture", prov: [{ page_no: 2 }] }],
  tables: [TABLE],
  texts: [
    text(0, "page_header", "arXiv:1908.05828v1 [cs.CL]", 1),
    text(1, "section_header", "1 Introduction", 1),
    text(2, "text", "We compare embeddings for Nepali NER.", 1),
    text(3, "list_item", "a new dataset", 1),
    text(4, "caption", "Table 1: F1 by embedding.", 2),
    text(5, "text", "GloVe is best on test.", 2),
    text(6, "caption", "Figure 2: Loss curves.", 2),
  ],
};

test("a Docling table becomes one labelled line per row, with stacked headers joined", () => {
  assert.deepEqual(renderDoclingTable(TABLE), [
    "Model | Raw Dev | Raw Test",
    "Model: BiLSTM; Raw Dev: 81.2; Raw Test: 76.9",
    "Model: GloVe; Raw Dev: 84.0; Raw Test: 80.1",
  ]);
  assert.deepEqual(renderDoclingTable({ data: { grid: [] } }), []);
});

test("a DoclingDocument flattens to pages in reading order without page furniture", () => {
  const pages = doclingDocumentToPages(DOCUMENT);

  assert.deepEqual(pages.map((page) => page.pageNumber), [1, 2, 3]);
  assert.equal(
    pages[0].text,
    "1 Introduction\n\nWe compare embeddings for Nepali NER.\n\n- a new dataset"
  );
  assert.equal(
    pages[1].text,
    [
      "Table 1: F1 by embedding.",
      "Model | Raw Dev | Raw Test",
      "Model: BiLSTM; Raw Dev: 81.2; Raw Test: 76.9",
      "Model: GloVe; Raw Dev: 84.0; Raw Test: 80.1",
      "Figure 2: Loss curves.",
      "GloVe is best on test.",
    ].join("\n\n")
  );
  assert.equal(pages[2].text, "", "a page with no body text is kept, empty");
});

let tempDirectory;

afterEach(async () => {
  if (tempDirectory) {
    await rm(tempDirectory, { force: true, recursive: true });
    tempDirectory = null;
  }
});

const writePdf = async () => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "docling-client-"));
  const filePath = path.join(tempDirectory, "paper.pdf");

  await writeFile(filePath, "%PDF-1.4 stub");
  return filePath;
};

test("the client posts the PDF to docling-serve and reads json_content", async () => {
  const filePath = await writePdf();
  const requests = [];
  const pages = await loadPdfPagesWithDocling(filePath, {
    fetchImpl: async (url, options) => {
      requests.push({ form: options.body, url });
      return {
        json: async () => ({ document: { json_content: DOCUMENT }, status: "success" }),
        ok: true,
        status: 200,
      };
    },
  });

  assert.equal(pages.length, 3);
  assert.match(requests[0].url, /\/v1\/convert\/file$/);
  assert.equal(requests[0].form.get("to_formats"), "json");
  assert.equal(requests[0].form.get("do_ocr"), "false");
  assert.equal(requests[0].form.get("files").name, "paper.pdf");
});

test("a failed conversion or an unreachable server is a DoclingParseError", async () => {
  const filePath = await writePdf();

  await assert.rejects(
    loadPdfPagesWithDocling(filePath, {
      fetchImpl: async () => ({
        json: async () => ({ document: {}, errors: [{ error_message: "bad pdf" }], status: "failure" }),
        ok: true,
        status: 200,
      }),
    }),
    {
      code: "DOCLING_CONVERSION_FAILED",
      httpStatus: 200,
      message: /could not convert paper\.pdf .*bad pdf/,
      name: "DoclingParseError",
      status: 502,
    }
  );
  await assert.rejects(
    loadPdfPagesWithDocling(filePath, {
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    }),
    { code: "DOCLING_UNREACHABLE", httpStatus: null, message: /unreachable: connect ECONNREFUSED/, name: "DoclingParseError" }
  );
});

test("the health probe reports whether docling-serve answers", async () => {
  assert.equal((await probeDoclingServe({ fetchImpl: async () => ({ ok: true }) })).reachable, true);

  const down = await probeDoclingServe({
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });

  assert.equal(down.reachable, false);
  assert.match(down.error, /ECONNREFUSED/);
});

test("a paragraph Docling merged over a page break is split back by page at whitespace", () => {
  // Spans count characters before dehyphenation ("repr-" + "esentation"), so
  // they can overshoot the merged text by a few characters.
  const merged = {
    label: "text",
    prov: [
      { charspan: [0, 26], page_no: 1 },
      { charspan: [27, 52], page_no: 2 },
    ],
    text: "Concept spaces are a representation of text by its concepts.",
  };

  assert.deepEqual(splitDoclingTextByPage(merged), [
    { page: 1, text: "Concept spaces are a" },
    { page: 2, text: " representation of text by its concepts." },
  ]);
  assert.equal(splitDoclingTextByPage(merged).map((part) => part.text).join(""), merged.text);
  // Three pages; several boxes on one page count as one part.
  assert.deepEqual(
    splitDoclingTextByPage({
      prov: [
        { charspan: [0, 5], page_no: 3 },
        { charspan: [6, 11], page_no: 3 },
        { charspan: [12, 17], page_no: 4 },
        { charspan: [18, 23], page_no: 5 },
      ],
      text: "aaaaa bbbbb ccccc ddddd",
    }),
    [
      { page: 3, text: "aaaaa bbbbb" },
      { page: 4, text: " ccccc" },
      { page: 5, text: " ddddd" },
    ]
  );
  // Without usable spans (missing, or pages going back) the item stays on its first page.
  for (const prov of [
    [{ page_no: 2 }, { page_no: 3 }],
    [{ charspan: [0, 4], page_no: 3 }, { charspan: [5, 9], page_no: 2 }],
    [{ charspan: [0, 9], page_no: 2 }],
  ]) {
    assert.deepEqual(splitDoclingTextByPage({ prov, text: "some text" }), [{ page: prov[0].page_no, text: "some text" }]);
  }
});

test("doclingDocumentToPages puts each part of a cross-page paragraph on its own page; a list item keeps one marker", () => {
  const pages = doclingDocumentToPages({
    body: { children: [{ $ref: "#/texts/0" }, { $ref: "#/texts/1" }] },
    pages: { 1: {}, 2: {} },
    texts: [
      text(0, "text", "First half of a sentence that ends on the next page.", 1, {
        prov: [
          { charspan: [0, 16], page_no: 1 },
          { charspan: [17, 54], page_no: 2 },
        ],
      }),
      text(1, "list_item", "an item that also runs over", 2),
    ],
  });

  assert.deepEqual(pages, [
    { pageNumber: 1, text: "First half of a" },
    { pageNumber: 2, text: "sentence that ends on the next page.\n\n- an item that also runs over" },
  ]);
});
