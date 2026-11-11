// Excel (.xlsx) pages: one page per visible worksheet, in workbook order.
//
//   pageNumber    the sheet's 1-based position in the workbook, counting
//                 hidden sheets and chart sheets, so a sheet keeps its number
//                 when another is hidden or shown.
//   locationUnit  "sheet"; locationLabel the sheet's name.
//   text          "Sheet: <name>", then one line per non-empty row. The header
//                 row is the first row, among the first 20 non-empty rows,
//                 with at least two non-empty cells and at least half as many
//                 as the widest of those rows. Rows above it (titles) are
//                 plain lines, cells joined by "; "; the header row itself is
//                 one too, so no column name is lost; every later row labels
//                 each non-empty cell by its header ("Header: value; ..."), a
//                 cell under an empty header (or one too long to be a label)
//                 by its column letter. Without a header row every row is a
//                 plain line.
//
// A cell reads as its displayed text (SheetJS cell.w: numbers and dates in
// their number format), else its value; a formula as its cached value, never
// evaluated. A merged range keeps its value in the top-left cell only.
// Hidden and very hidden sheets, chart sheets and sheets without a non-empty
// cell give no page.
//
// SheetJS never sees the uploaded ZIP. rag/office/xlsx-plan.js picks the
// parts of the guard's scan (the visible worksheets, shared strings, styles)
// and SheetJS reads a workbook rebuilt from them, in two passes: the first
// reads only the workbook part and the styles, for the sheet list, date1904,
// the number formats and the cell formats, so a number format longer than
// Excel allows is refused before any cell is formatted; the second reads the
// rebuilt workbook's cells, with styles written from what the first read.
// SheetJS does not format the cells (cellText off): each cell keeps its
// format string (cellNF) and is formatted here, one at a time, by SheetJS's
// own formatter, as SheetJS would have formatted it. Formatting them all
// inside the parse kept every cell's text alive at once, so a 310 KB
// workbook of 1.9 million cells whose 254-character date format expands
// every cell to 400 characters needed some 5 GB of heap (400,000 cells took
// 1.1 GB, measured); formatted here, the text budget refuses it at 0.8 GB.
//
// RAG_XLSX_MAX_CELLS bounds the non-empty cells of the visible sheets; above
// it the workbook is refused (413 DOCUMENT_SPREADSHEET_TOO_LARGE), never
// truncated, and the cell elements of the worksheets are counted before
// SheetJS parses them (xlsx-plan.js). RAG_OFFICE_MAX_TEXT_CHARS bounds the
// text: the cells' text is counted as it is read, the lines as they are
// written (413 DOCUMENT_ARCHIVE_TOO_LARGE).
import * as XLSX from "xlsx";

import { getOfficeMaxTextChars, getOfficeMaxXmlBytes, getXlsxMaxCells } from "../config.js";
import { createArchiveInvalidError, createSpreadsheetTooLargeError } from "../document-format-errors.js";
import { buildHeaderLabels, createTextBudget, formatLabelledRow, formatPlainRow, normalizeLineText } from "./table-text.js";
import {
  REBUILT_PARTS,
  buildContentTypesXml,
  buildStylesXml,
  buildWorkbookRelationshipsXml,
  buildWorkbookXml,
  prepareWorksheets,
  readWorkbookParts,
} from "./xlsx-plan.js";
import { scanOfficeArchive } from "./zip-guard.js";

export { XLSX_CELL_PRECHECK_FACTOR, prepareWorksheetPart } from "./xlsx-plan.js";

export const XLSX_EXTRACTOR = "sheetjs";
export const XLSX_LOCATION_UNIT = "sheet";

// The header row is looked for among this many non-empty rows.
export const XLSX_HEADER_SEARCH_ROWS = 20;

// Excel refuses a number format longer than this.
export const XLSX_MAX_NUMBER_FORMAT_LENGTH = 255;

/** The installed SheetJS's version. The package exports no package.json; XLSX.version is the same string. */
export const getSheetjsVersion = () => XLSX.version;

// Cached formula values and each cell's number format string (cellNF), no
// displayed text (cellText: formatted here, a cell at a time), no formula
// text, no HTML, no styles beyond the number formats, no stub cells for
// empty ones; dense rows, which take less memory than one key per cell.
const READ_OPTIONS = Object.freeze({
  bookDeps: false,
  bookFiles: false,
  bookProps: false,
  bookSheets: false,
  bookVBA: false,
  cellDates: false,
  cellFormula: false,
  cellHTML: false,
  cellNF: true,
  cellStyles: false,
  cellText: false,
  dense: true,
  sheetStubs: false,
  type: "buffer",
  WTF: false,
});

// The number formats SheetJS 0.20.3 loads only when a cell uses an id the
// workbook leaves undefined (its SSFImplicit table; ids it reads as General
// left out), as the installed SheetJS reports them: test/office-xlsx-loader
// checks the table against it. The rebuilt styles define them, so a cell
// with such an id carries its format string like any other.
export const SHEETJS_IMPLICIT_NUMBER_FORMATS = Object.freeze({
  5: '"$"#,##0_);\\("$"#,##0\\)',
  6: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  7: '"$"#,##0.00_);\\("$"#,##0.00\\)',
  8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  27: "m/d/yy",
  28: "m/d/yy",
  29: "m/d/yy",
  30: "m/d/yy",
  31: "m/d/yy",
  32: "h:mm:ss",
  33: "h:mm:ss",
  34: "h:mm:ss",
  35: "h:mm:ss",
  36: "m/d/yy",
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)',
  50: "m/d/yy",
  51: "m/d/yy",
  52: "m/d/yy",
  53: "m/d/yy",
  54: "m/d/yy",
  55: "m/d/yy",
  57: "m/d/yy",
  58: "m/d/yy",
  59: "0",
  60: "0.00",
  61: "#,##0",
  62: "#,##0.00",
  63: '"$"#,##0_);\\("$"#,##0\\)',
  64: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  65: '"$"#,##0.00_);\\("$"#,##0.00\\)',
  66: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  67: "0%",
  68: "0.00%",
  69: "# ?/?",
  70: "# ??/??",
  71: "m/d/yy",
  72: "m/d/yy",
  73: "d-mmm-yy",
  74: "d-mmm",
  75: "mmm-yy",
  76: "h:mm",
  77: "h:mm:ss",
  78: "m/d/yy h:mm",
  79: "mm:ss",
  80: "[h]:mm:ss",
  81: "mmss.0",
});

// A ZIP of `parts` ([name, bytes]), stored, written by SheetJS's own ZIP
// writer.
const buildWorkbookZip = (parts) => {
  const container = XLSX.CFB.utils.cfb_new();

  for (const [name, bytes] of parts) {
    XLSX.CFB.utils.cfb_add(container, name, bytes);
  }

  return XLSX.CFB.write(container, { compression: false, fileType: "zip", type: "buffer" });
};

const readWorkbookZip = (zip) => {
  try {
    // A fresh options object: SheetJS writes its defaults into the one it gets.
    return XLSX.read(zip, { ...READ_OPTIONS });
  } catch (error) {
    throw createArchiveInvalidError("the Excel workbook cannot be read", { cause: error });
  }
};

// The number of times a number format's sections hold the text placeholder
// "@", at most, sections split the way SheetJS splits them (at every ";",
// the character after "_", "*" or "\" skipped). Quoted "@" count too: the
// count only has to err high.
const maxTextPlaceholdersPerSection = (format) => {
  let most = 0;
  let current = 0;

  for (let index = 0; index < format.length; index += 1) {
    const character = format[index];

    if (character === "_" || character === "*" || character === "\\") {
      index += 1;
    } else if (character === ";") {
      most = Math.max(most, current);
      current = 0;
    } else if (character === "@") {
      current += 1;
    }
  }

  return Math.max(most, current);
};

/**
 * Refuses (400 DOCUMENT_ARCHIVE_INVALID) number formats SheetJS would spend
 * without bound on every cell that uses them: one longer than Excel allows
 * (SheetJS tokenizes the whole format for each cell, and writes every literal
 * into each cell's text: a 100,000-character format over 2,000 cells
 * exhausted the heap of a 9 KB workbook, measured) or one that repeats the
 * text placeholder within a section (each "@" copies the cell's whole text).
 */
export const assertReadableNumberFormats = (numberFormats) => {
  for (const format of Object.values(numberFormats ?? {})) {
    if (typeof format !== "string") {
      continue;
    }

    if (format.length > XLSX_MAX_NUMBER_FORMAT_LENGTH) {
      throw createArchiveInvalidError(
        `a number format is longer than the ${XLSX_MAX_NUMBER_FORMAT_LENGTH} characters Excel allows`
      );
    }

    if (maxTextPlaceholdersPerSection(format) > 1) {
      throw createArchiveInvalidError("a number format repeats its text placeholder");
    }
  }
};

// The first pass: the workbook part and the styles alone, under a content
// types part written here. SheetJS reads the sheet list (names, hidden
// states, relationship ids), date1904, the number formats and each cell
// format's number format id, and finds no worksheet to parse.
const readWorkbookStructure = ({ styles, workbook }) => {
  const read = readWorkbookZip(
    buildWorkbookZip([
      [REBUILT_PARTS.contentTypes, buildContentTypesXml({ styles: Boolean(styles) })],
      [REBUILT_PARTS.workbook, workbook],
      ...(styles ? [[REBUILT_PARTS.styles, styles]] : []),
    ])
  );
  const sheets = read.Workbook?.Sheets ?? [];
  const cellFormats = read.Styles?.CellXf;

  return {
    cellFormats: Array.isArray(cellFormats) ? cellFormats.map((format) => format?.numFmtId ?? null) : null,
    date1904: Boolean(read.Workbook?.WBProps?.date1904),
    names: read.SheetNames ?? [],
    numberFormats: read.Styles?.NumberFmt ?? null,
    sheets: sheets.map((sheet) => ({
      hidden: Boolean(sheet?.Hidden),
      id: typeof sheet?.id === "string" ? sheet.id.trim() : "",
    })),
  };
};

// Every present cell of a sheet as (row, column, cell), rows and columns
// ascending. Object.keys walks only the indices a sparse row holds, so a lone
// cell in column XFD costs one step, not 16384.
const forEachCell = (sheet, visit) => {
  const data = sheet["!data"];

  if (Array.isArray(data)) {
    for (const rowKey of Object.keys(data)) {
      const row = data[rowKey];

      if (!Array.isArray(row)) {
        continue;
      }

      const rowIndex = Number(rowKey);

      for (const columnKey of Object.keys(row)) {
        if (row[columnKey]) {
          visit(rowIndex, Number(columnKey), row[columnKey]);
        }
      }
    }

    return;
  }

  const cells = [];

  for (const key of Object.keys(sheet)) {
    if (!key.startsWith("!")) {
      const { c, r } = XLSX.utils.decode_cell(key);

      cells.push([r, c, sheet[key]]);
    }
  }

  cells.sort((left, right) => left[0] - right[0] || left[1] - right[1]);

  for (const [rowIndex, columnIndex, cell] of cells) {
    visit(rowIndex, columnIndex, cell);
  }
};

// A cell's displayed text, or null for none: formatted here as SheetJS
// formats a cell while it parses with cellText on -- its number format
// string (cellNF; General without one) through SheetJS's formatter, with the
// workbook's date1904, an error as its code's text, the value itself when
// the formatter fails -- so the text is what it was when SheetJS formatted
// every cell, one cell at a time instead of all at once.
const rawCellText = (cell, { date1904 = false } = {}) => {
  if (!cell || cell.t === "z") {
    return null;
  }

  if (cell.w !== undefined) {
    return cell.w === null ? null : String(cell.w);
  }

  if (cell.t === "e") {
    const text = XLSX.utils.format_cell(cell);

    return text === undefined || text === null ? null : String(text);
  }

  if (cell.v === undefined || cell.v === null) {
    return null;
  }

  try {
    return String(XLSX.SSF.format(typeof cell.z === "string" ? cell.z : "General", cell.v, { date1904 }));
  } catch {
    return String(cell.v);
  }
};

/** A cell's text: its displayed text, else its value, whitespace collapsed; "" for none. */
export const readCellText = (cell, options = {}) => {
  const raw = rawCellText(cell, options);

  return raw === null ? "" : normalizeLineText(raw);
};

// Coalesced, sorted column intervals [[from, to], ...]: overlapping and
// adjacent ones merged, so a lookup is one binary search.
const coalesceIntervals = (intervals) => {
  const sorted = intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];

  for (const [from, to] of sorted) {
    const last = merged.at(-1);

    if (last && from <= last[1] + 1) {
      last[1] = Math.max(last[1], to);
    } else {
      merged.push([from, to]);
    }
  }

  return merged;
};

// The cells a merged range hides, by row: for each row with cells, the
// column intervals to blank (every cell of a range but its top-left one),
// coalesced. Only rows that hold cells are visited, and their number is
// bounded, so a range as large as the sheet costs no more than the rows it
// covers; a sheet whose ranges would need more than `budget` row visits is
// refused.
const buildMergeShadows = (sheet, rowsWithCells, budget, maxCells) => {
  const shadows = new Map();
  let visits = 0;

  for (const range of sheet["!merges"] ?? []) {
    const { e: end, s: start } = range ?? {};

    if (!start || !end) {
      continue;
    }

    // The first row with cells inside the range (binary search).
    let low = 0;
    let high = rowsWithCells.length;

    while (low < high) {
      const middle = (low + high) >>> 1;

      if (rowsWithCells[middle] < start.r) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    for (let index = low; index < rowsWithCells.length && rowsWithCells[index] <= end.r; index += 1) {
      visits += 1;

      if (visits > budget) {
        throw createSpreadsheetTooLargeError(maxCells);
      }

      const rowIndex = rowsWithCells[index];
      const from = rowIndex === start.r ? start.c + 1 : start.c;

      if (from <= end.c) {
        const intervals = shadows.get(rowIndex) ?? [];

        intervals.push([from, end.c]);
        shadows.set(rowIndex, intervals);
      }
    }
  }

  for (const [rowIndex, intervals] of shadows) {
    shadows.set(rowIndex, coalesceIntervals(intervals));
  }

  return shadows;
};

// Whether a column falls inside one of a row's coalesced intervals: a binary
// search, so a row with many merged ranges costs log(ranges) per cell, not
// ranges (400,000 ranges over a row's cells took 27 s, measured).
const isShadowed = (intervals, columnIndex) => {
  let low = 0;
  let high = intervals.length - 1;

  while (low <= high) {
    const middle = (low + high) >>> 1;
    const [from, to] = intervals[middle];

    if (columnIndex < from) {
      high = middle - 1;
    } else if (columnIndex > to) {
      low = middle + 1;
    } else {
      return true;
    }
  }

  return false;
};

/**
 * A worksheet's non-empty rows: [{ row, cells: [{ column, text }] }], merged-
 * away cells left out. `budget` (a text budget) is spent with each cell's
 * raw text before it is copied; `counter` ({ cells }) counts the non-empty
 * cells across the workbook against `maxCells`; `date1904` is the
 * workbook's date system.
 */
export const readSheetRows = (
  sheet,
  { budget = createTextBudget(), counter = { cells: 0 }, date1904 = false, maxCells = getXlsxMaxCells() } = {}
) => {
  const byRow = new Map();

  forEachCell(sheet, (rowIndex, columnIndex, cell) => {
    const raw = rawCellText(cell, { date1904 });

    if (raw === null) {
      return;
    }

    // By length first: a formatted cell's text can be a long concatenation
    // that only becomes a copy once something reads it.
    budget.spend(raw.length);

    const text = normalizeLineText(raw);

    if (!text) {
      return;
    }

    counter.cells += 1;

    if (counter.cells > maxCells) {
      throw createSpreadsheetTooLargeError(maxCells);
    }

    const cells = byRow.get(rowIndex) ?? [];

    cells.push({ column: columnIndex, text });
    byRow.set(rowIndex, cells);
  });

  const rowsWithCells = [...byRow.keys()].sort((left, right) => left - right);
  const shadows = buildMergeShadows(sheet, rowsWithCells, 4 * maxCells, maxCells);

  return rowsWithCells
    .map((rowIndex) => {
      const intervals = shadows.get(rowIndex);

      return {
        cells: intervals ? byRow.get(rowIndex).filter((cell) => !isShadowed(intervals, cell.column)) : byRow.get(rowIndex),
        row: rowIndex,
      };
    })
    .filter((row) => row.cells.length > 0);
};

/** The position (in `rows`) of the header row, or -1 (see the header of this module). */
export const findHeaderRow = (rows) => {
  const candidates = rows.slice(0, XLSX_HEADER_SEARCH_ROWS);
  let widest = 0;

  for (const row of candidates) {
    widest = Math.max(widest, row.cells.length);
  }

  return candidates.findIndex((row) => row.cells.length >= 2 && row.cells.length * 2 >= widest);
};

/**
 * A worksheet's page text lines, the "Sheet:" line first; null without a
 * non-empty cell. Each line is spent from `budget` as it is written.
 */
export const formatSheetLines = (name, rows, { budget = createTextBudget() } = {}) => {
  if (rows.length === 0) {
    return null;
  }

  const headerPosition = findHeaderRow(rows);
  const labels = headerPosition === -1 ? null : buildHeaderLabels(rows[headerPosition].cells);
  const lines = [];
  const addLine = (line) => {
    if (line) {
      budget.spend(line.length + 1);
      lines.push(line);
    }
  };

  addLine(normalizeLineText(`Sheet: ${name}`));

  rows.forEach((row, position) => {
    addLine(labels && position > headerPosition ? formatLabelledRow(row.cells, labels) : formatPlainRow(row.cells));
  });

  return lines;
};

const isWorksheet = (sheet) => Boolean(sheet) && (sheet["!type"] === undefined || sheet["!type"] === "sheet");

/**
 * The pages of a workbook SheetJS read: [{ pageNumber, text, locationUnit:
 * "sheet", locationLabel }]. `positions[k]` is the 0-based workbook position
 * of the workbook's k-th sheet (by default k itself); hidden sheets and
 * sheets of other kinds give no page. Refuses more than `maxCells` non-empty
 * cells (413 DOCUMENT_SPREADSHEET_TOO_LARGE) and more than `maxTextChars` of
 * text (413 DOCUMENT_ARCHIVE_TOO_LARGE).
 */
export const workbookToPages = (
  workbook,
  { maxCells = getXlsxMaxCells(), maxTextChars = getOfficeMaxTextChars(), positions = null } = {}
) => {
  const sheets = (workbook.SheetNames ?? [])
    .map((name, index) => ({ index, name, position: positions ? positions[index] : index, sheet: workbook.Sheets?.[name] }))
    .filter(({ index, sheet }) => isWorksheet(sheet) && !workbook.Workbook?.Sheets?.[index]?.Hidden);
  const cellBudget = createTextBudget(maxTextChars);
  const lineBudget = createTextBudget(maxTextChars);
  const counter = { cells: 0 };
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
  const rowsBySheet = sheets.map(({ sheet }) => readSheetRows(sheet, { budget: cellBudget, counter, date1904, maxCells }));

  return sheets.flatMap(({ name, position }, sheetIndex) => {
    const lines = formatSheetLines(name, rowsBySheet[sheetIndex], { budget: lineBudget });
    const label = normalizeLineText(name);

    return lines
      ? [
          {
            pageNumber: position + 1,
            text: lines.join("\n"),
            locationUnit: XLSX_LOCATION_UNIT,
            ...(label ? { locationLabel: label } : {}),
          },
        ]
      : [];
  });
};

/**
 * The pages of a .xlsx from the archive guard's scan of its bytes
 * (scanOfficeArchive), the way rag/document-loader.js reads one: the parts
 * chosen and bounded (xlsx-plan.js), the number formats checked, then the
 * rebuilt workbook read and turned into pages (workbookToPages). Options:
 * maxCells (RAG_XLSX_MAX_CELLS), maxTextChars (RAG_OFFICE_MAX_TEXT_CHARS),
 * maxXmlBytes (RAG_OFFICE_MAX_XML_BYTES).
 */
export const extractXlsxPagesFromArchive = async (
  archive,
  {
    maxCells = getXlsxMaxCells(),
    maxTextChars = getOfficeMaxTextChars(),
    maxXmlBytes = getOfficeMaxXmlBytes(),
  } = {}
) => {
  const parts = await readWorkbookParts(archive, { maxXmlBytes });
  const structure = readWorkbookStructure(parts);

  assertReadableNumberFormats(structure.numberFormats);

  const worksheets = await prepareWorksheets(archive, { relationships: parts.relationships, sheets: structure.sheets }, { maxCells });
  // What SheetJS formats cells with, as the first pass read it.
  const styles = parts.styles
    ? buildStylesXml({
        cellFormats: structure.cellFormats,
        implicitFormats: SHEETJS_IMPLICIT_NUMBER_FORMATS,
        numberFormats: structure.numberFormats,
      })
    : null;
  const workbook = readWorkbookZip(
    buildWorkbookZip([
      [
        REBUILT_PARTS.contentTypes,
        buildContentTypesXml({
          sharedStrings: Boolean(parts.sharedStrings),
          styles: Boolean(styles),
          worksheets: worksheets.length,
        }),
      ],
      [
        REBUILT_PARTS.workbook,
        buildWorkbookXml({ date1904: structure.date1904, names: worksheets.map(({ index }) => structure.names[index]) }),
      ],
      [REBUILT_PARTS.relationships, buildWorkbookRelationshipsXml(worksheets.length)],
      ...(parts.sharedStrings ? [[REBUILT_PARTS.sharedStrings, parts.sharedStrings]] : []),
      ...(styles ? [[REBUILT_PARTS.styles, styles]] : []),
      ...worksheets.map(({ bytes }, position) => [REBUILT_PARTS.worksheet(position), bytes]),
    ])
  );

  return workbookToPages(workbook, { maxCells, maxTextChars, positions: worksheets.map(({ index }) => index) });
};

/**
 * A .xlsx buffer's pages: the archive guard's scan (scanOfficeArchive, with
 * the guard's own limits), then extractXlsxPagesFromArchive with `options`.
 */
export const extractXlsxPages = async (buffer, options = {}) =>
  extractXlsxPagesFromArchive(await scanOfficeArchive(buffer), options);
