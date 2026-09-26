// Layout-aware PDF parsing through a docling-serve instance (PDF_PARSER=docling).
//
// pdf.js returns a page's text items in content-stream order and joins them by
// y position: a two-column page interleaves its columns line by line, and a
// table comes out as numbers without the column they belong to. Docling runs a
// layout model and a table-structure model, so it returns the page in reading
// order and every table as a grid of cells. This module sends the PDF to the
// docling-serve HTTP API and flattens the DoclingDocument it returns into the
// same `[{ pageNumber, text }]` pages the chunker already consumes:
//
//   - body items in reading order, page headers/footers and other furniture
//     dropped;
//   - a table as its caption, then one line per row, each cell labelled with
//     its column header ("Model: BERT; F1: 84.2"), so a row split into another
//     chunk still says what every number is;
//   - figures as their captions only.

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  getDoclingServeUrl,
  getDoclingTimeoutMs,
  isDoclingOcrEnabled,
} from "./config.js";

const SKIPPED_TEXT_LABELS = new Set(["page_header", "page_footer"]);
const NUMERIC_CELL = /^[\s~<>≈±+\-−]*\d/;
const MAX_HEADER_ROWS = 3;

const resolveRef = (document, ref) => {
  const match = /^#\/(texts|tables|groups|pictures)\/(\d+)$/.exec(String(ref ?? ""));

  return match ? { collection: match[1], item: document[match[1]]?.[Number(match[2])] ?? null } : null;
};

const pageOf = (item) => Number(item?.prov?.[0]?.page_no) || null;

const cleanCell = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

// The grid repeats a spanning cell in every position it covers; a row keeps
// it once.
const dedupeRowCells = (cells) =>
  cells.filter((cell, index) => index === 0 || cell.text !== cells[index - 1].text || !cell.text);

/**
 * One line per row. Header rows (every cell a column header) name the
 * columns; each later row labels its cells with those names.
 */
export const renderDoclingTable = (table) => {
  const grid = table?.data?.grid ?? [];

  if (grid.length === 0) {
    return [];
  }

  const isHeaderRow = (row) => row.length > 0 && row.every((cell) => cell.column_header || !cleanCell(cell.text));
  // Docling often flags only the first row of a stacked header ("Raw" /
  // "Lemmatized" over "Train" / "Test"); a following row with no number past
  // the first column is taken as header too while later rows hold numbers.
  const hasNumberPastFirstColumn = (row) => row.slice(1).some((cell) => NUMERIC_CELL.test(cleanCell(cell.text)));
  const laterRowsHoldNumbers = (index) => grid.slice(index + 1).some(hasNumberPastFirstColumn);
  let headerRowCount = 0;

  while (headerRowCount < grid.length - 1 && isHeaderRow(grid[headerRowCount])) {
    headerRowCount += 1;
  }

  while (
    headerRowCount > 0 &&
    headerRowCount < Math.min(MAX_HEADER_ROWS, grid.length - 1) &&
    !hasNumberPastFirstColumn(grid[headerRowCount]) &&
    laterRowsHoldNumbers(headerRowCount)
  ) {
    headerRowCount += 1;
  }

  const columnNames = (grid[0] ?? []).map((_cell, column) =>
    [...new Set(grid.slice(0, headerRowCount).map((row) => cleanCell(row[column]?.text)).filter(Boolean))].join(" ")
  );
  const lines = [];

  if (headerRowCount > 0) {
    lines.push(dedupeRowCells(columnNames.map((text) => ({ text }))).map((cell) => cell.text).filter(Boolean).join(" | "));
  }

  for (const row of grid.slice(headerRowCount)) {
    const cells = dedupeRowCells(
      row.map((cell, column) => ({ name: columnNames[column] ?? "", text: cleanCell(cell.text) }))
    ).filter((cell) => cell.text);

    if (cells.length > 0) {
      lines.push(cells.map((cell) => (cell.name && cell.name !== cell.text ? `${cell.name}: ${cell.text}` : cell.text)).join("; "));
    }
  }

  return lines;
};

/**
 * Flattens a DoclingDocument (docling-serve `json_content`) into pages of
 * text, 1..page count, in reading order.
 */
export const doclingDocumentToPages = (document) => {
  const pageCount = Math.max(
    0,
    ...Object.keys(document?.pages ?? {}).map(Number).filter(Number.isFinite)
  );
  const blocksByPage = new Map();
  const consumed = new Set();
  const emit = (page, text) => {
    const value = String(text ?? "").trim();

    if (!page || !value) {
      return;
    }

    if (!blocksByPage.has(page)) {
      blocksByPage.set(page, []);
    }

    blocksByPage.get(page).push(value);
  };
  const captionText = (item) =>
    (item?.captions ?? [])
      .map((ref) => {
        consumed.add(ref.$ref);
        return resolveRef(document, ref.$ref)?.item?.text ?? "";
      })
      .filter(Boolean)
      .join(" ");

  const visit = (ref) => {
    if (!ref || consumed.has(ref)) {
      return;
    }

    consumed.add(ref);
    const resolved = resolveRef(document, ref);
    const item = resolved?.item;

    if (!item || (item.content_layer && item.content_layer !== "body")) {
      return;
    }

    if (resolved.collection === "tables") {
      const page = pageOf(item);

      emit(page, captionText(item));
      for (const line of renderDoclingTable(item)) {
        emit(page, line);
      }
    } else if (resolved.collection === "pictures") {
      emit(pageOf(item), captionText(item));
    } else if (resolved.collection === "texts" && !SKIPPED_TEXT_LABELS.has(item.label)) {
      emit(pageOf(item), item.label === "list_item" ? `- ${item.text}` : item.text);
    }

    for (const child of item.children ?? []) {
      visit(child.$ref);
    }
  };

  for (const child of document?.body?.children ?? []) {
    visit(child.$ref);
  }

  const lastPage = Math.max(pageCount, ...blocksByPage.keys());

  return Array.from({ length: lastPage }, (_value, index) => ({
    pageNumber: index + 1,
    text: (blocksByPage.get(index + 1) ?? []).join("\n\n"),
  }));
};

export class DoclingParseError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = "DoclingParseError";
    this.status = 502;
  }
}

/** Converts one PDF through docling-serve and returns its pages. */
export const loadPdfPagesWithDocling = async (filePath, { fetchImpl = globalThis.fetch } = {}) => {
  const form = new FormData();

  form.append("files", new Blob([await readFile(filePath)], { type: "application/pdf" }), path.basename(filePath));
  form.append("to_formats", "json");
  form.append("image_export_mode", "placeholder");
  form.append("do_ocr", String(isDoclingOcrEnabled()));

  let response;

  try {
    response = await fetchImpl(`${getDoclingServeUrl()}/v1/convert/file`, {
      body: form,
      method: "POST",
      signal: AbortSignal.timeout(getDoclingTimeoutMs()),
    });
  } catch (error) {
    throw new DoclingParseError(`docling-serve at ${getDoclingServeUrl()} is unreachable: ${error.message}`, { cause: error });
  }

  const payload = await response.json().catch(() => null);
  const document = payload?.document?.json_content;

  if (!response.ok || payload?.status === "failure" || !document) {
    const detail = payload?.errors?.map((error) => error.error_message ?? JSON.stringify(error)).join("; ");

    throw new DoclingParseError(
      `docling-serve could not convert ${path.basename(filePath)} (HTTP ${response.status}${detail ? `: ${detail}` : ""}).`
    );
  }

  return doclingDocumentToPages(document);
};

/** For the health report: is the configured docling-serve answering? */
export const probeDoclingServe = async ({ fetchImpl = globalThis.fetch } = {}) => {
  try {
    const response = await fetchImpl(`${getDoclingServeUrl()}/health`, { signal: AbortSignal.timeout(3000) });

    return { reachable: response.ok, url: getDoclingServeUrl() };
  } catch (error) {
    return { error: error.message, reachable: false, url: getDoclingServeUrl() };
  }
};
