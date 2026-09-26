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
    { message: /could not convert paper\.pdf .*bad pdf/, name: "DoclingParseError" }
  );
  await assert.rejects(
    loadPdfPagesWithDocling(filePath, {
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    }),
    { message: /unreachable: connect ECONNREFUSED/, name: "DoclingParseError" }
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
