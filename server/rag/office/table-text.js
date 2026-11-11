// Text helpers the Office loaders share, so a table reads the same way whether
// it sat in a Word document, a deck or a workbook: one line per row, a header
// row's cells joined by "; ", and every later row's non-empty cells labelled
// by the header above them ("Header: value; Header: value"), a cell under an
// empty header -- or under one longer than MAX_HEADER_LABEL_LENGTH -- by its
// column letter. And the text budget every Office loader spends
// (RAG_OFFICE_MAX_TEXT_CHARS).
import { getOfficeMaxTextChars } from "../config.js";
import { createArchiveTooLargeError } from "../document-format-errors.js";

// A header cell longer than this is prose, not a label. Every later row
// repeats its header labels, so without a bound one long header cell over
// many short rows turns a few-KB file into a page of hundreds of MB (a 25 KB
// workbook with a 32,000-character header spelled out 96 MB, measured). The
// header line itself still carries the whole text once.
export const MAX_HEADER_LABEL_LENGTH = 200;

/**
 * A running count of the characters one document's loader produces, against
 * RAG_OFFICE_MAX_TEXT_CHARS (`maxChars`, else the setting): `spend(length)`
 * adds them and throws 413 DOCUMENT_ARCHIVE_TOO_LARGE once the count passes
 * the limit; `assertFits(length)` refuses a string that alone would pass it,
 * by its length, before anything copies it (a formatted cell can be a
 * concatenation of many repeats that is only copied when it is read).
 */
export const createTextBudget = (maxChars = getOfficeMaxTextChars()) => {
  let spent = 0;
  const refuse = () => {
    throw createArchiveTooLargeError(`its text runs to more than ${maxChars} characters (RAG_OFFICE_MAX_TEXT_CHARS)`);
  };

  return {
    assertFits(length) {
      if (spent + length > maxChars) {
        refuse();
      }
    },
    maxChars,
    spend(length) {
      spent += length;

      if (spent > maxChars) {
        refuse();
      }
    },
  };
};

/** Collapses every run of whitespace (NBSP and line breaks included) into one space and trims. */
export const normalizeLineText = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** Spreadsheet column letters for a 0-based column index: 0 -> A, 25 -> Z, 26 -> AA. */
export const columnLetter = (index) => {
  let remaining = Math.floor(index) + 1;
  let letters = "";

  while (remaining > 0) {
    const digit = (remaining - 1) % 26;

    letters = String.fromCharCode(65 + digit) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }

  return letters;
};

/** A row as a plain line: its non-empty cells' text joined by "; ". */
export const formatPlainRow = (cells) =>
  cells
    .map((cell) => normalizeLineText(cell.text))
    .filter(Boolean)
    .join("; ");

/**
 * A row labelled by a header: `cells` [{ column, text }], `headerLabels` a Map
 * from column index to the header text over it. A cell whose header is empty
 * or missing is labelled by its column letter.
 */
export const formatLabelledRow = (cells, headerLabels) =>
  cells
    .map((cell) => {
      const text = normalizeLineText(cell.text);

      if (!text) {
        return "";
      }

      const label = normalizeLineText(headerLabels.get(cell.column)) || columnLetter(cell.column);

      return `${label}: ${text}`;
    })
    .filter(Boolean)
    .join("; ");

/**
 * The header labels of a header row's cells, [{ column, text, span? }], by
 * column index. A header longer than MAX_HEADER_LABEL_LENGTH labels nothing
 * (its column letter stands in), so the long text is written once, in the
 * header line, instead of on every row.
 */
export const buildHeaderLabels = (headerCells) => {
  const labels = new Map();

  for (const cell of headerCells) {
    const text = normalizeLineText(cell.text);
    const label = text.length > MAX_HEADER_LABEL_LENGTH ? "" : text;
    const span = Math.max(1, cell.span ?? 1);

    for (let offset = 0; offset < span; offset += 1) {
      labels.set(cell.column + offset, label);
    }
  }

  return labels;
};
