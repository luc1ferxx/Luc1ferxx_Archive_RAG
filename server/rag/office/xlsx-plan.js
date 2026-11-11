// What SheetJS is given of a .xlsx, decided here from the archive guard's scan
// (rag/office/zip-guard.js) with no SheetJS involved: rag/office/xlsx-loader.js
// never hands SheetJS the uploaded ZIP. It rebuilds a workbook from the parts
// chosen here -- the visible worksheets and the shared strings as they are,
// the styles rewritten (buildStylesXml) from what a first SheetJS pass read
// of the original ones -- under a content types part, a workbook part and
// workbook relationships written here too, so SheetJS parses nothing the
// bounds below did not see.
//
// Why: SheetJS picks the parts it parses on its own (the first workbook its
// [Content_Types].xml names, tags its regular expressions find in comments,
// attribute names it shortens), parses any worksheet part whatever its name,
// and also reads comments, drawings, charts and external links. A count
// taken over the parts this module would pick was therefore a count over
// parts SheetJS might not parse, and a hyperlink whose range spans the
// sheet made it create a stub cell for every cell of that range.
//
// SheetJS holds every cell it parses in memory (about 130 bytes a numeric
// cell, measured), and RAG_XLSX_MAX_CELLS is counted on its parsed cells. So
// the worksheets handed over are counted first, and a workbook whose visible
// worksheets hold more than XLSX_CELL_PRECHECK_FACTOR times the limit in
// cell elements (as SheetJS's own pattern finds them, empty ones included,
// plus their merged ranges) is refused before SheetJS runs.
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

import { getOfficeMaxXmlBytes, getXlsxMaxCells } from "../config.js";
import { createArchiveInvalidError, createSpreadsheetTooLargeError } from "../document-format-errors.js";
import { CONTENT_TYPES_PART, assertXmlPartWithinLimit, decodeXmlPart, resolvePackageTarget } from "./zip-guard.js";

// The pre-parse bound: cell elements of the visible worksheets, in multiples
// of RAG_XLSX_MAX_CELLS. Twice the limit, because an element can hold
// nothing (a styled empty cell, a formula's empty text) and only displayed
// cells count against the limit itself.
export const XLSX_CELL_PRECHECK_FACTOR = 2;

// SheetJS reads any ZIP holding one of these as an OpenDocument or Numbers
// file; SheetJS never sees the uploaded ZIP now, but a real .xlsx never holds
// them, so such a package is still refused as a disguised file.
const FOREIGN_SPREADSHEET_PARTS = Object.freeze(["meta-inf/manifest.xml", "objectdata.xml", "index/document.iwa"]);

const RELATIONSHIP_TYPE_PREFIXES = Object.freeze([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/",
]);

// The relationship types SheetJS parses as worksheets (and a relationship
// without a type, which it reads as one too); chart, dialog and macro sheets
// give no page and are never handed over.
const WORKSHEET_RELATIONSHIP_TYPES = Object.freeze(
  RELATIONSHIP_TYPE_PREFIXES.map((prefix) => `${prefix}worksheet`)
);

const relationshipKind = (type) => {
  const prefix = RELATIONSHIP_TYPE_PREFIXES.find((candidate) => type.startsWith(candidate));

  return prefix ? type.slice(prefix.length) : null;
};

const RELATIONSHIP_PARSER_OPTIONS = Object.freeze({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  isArray: (name) => name === "Relationship" || name === "Override",
  parseAttributeValue: false,
  parseTagValue: false,
  removeNSPrefix: true,
});

const RELATED_PART_CONTENT_TYPES = Object.freeze({
  sharedStrings: "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
  styles: "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
});

const asText = (value) => (typeof value === "string" ? value : "");

// The first [Content_Types].xml override of `contentType` (the guard keeps
// that part), as a part name, or null.
const findContentTypeOverride = (archive, contentType) => {
  const name = [...archive.parts.keys()].find((partName) => partName.toLowerCase() === CONTENT_TYPES_PART.toLowerCase());

  if (!name) {
    return null;
  }

  let parsed;

  try {
    parsed = new XMLParser(RELATIONSHIP_PARSER_OPTIONS).parse(decodeXmlPart(archive.parts.get(name)));
  } catch (error) {
    throw createArchiveInvalidError("its content types cannot be read", { cause: error });
  }

  // MIME types compare without regard to case.
  const override = (parsed?.Types?.Override ?? []).find(
    (entry) => asText(entry?.ContentType).trim().toLowerCase() === contentType.toLowerCase()
  );

  return override ? resolvePackageTarget(override.PartName) : null;
};

/**
 * The workbook's relationships: Map from Id to { target (the part name it
 * resolves to, null outside the package or for an external target), type }.
 */
export const readWorkbookRelationships = (buffer, workbookDirectory) => {
  let parsed;

  try {
    parsed = new XMLParser(RELATIONSHIP_PARSER_OPTIONS).parse(decodeXmlPart(buffer));
  } catch (error) {
    throw createArchiveInvalidError("its workbook relationships cannot be read", { cause: error });
  }

  const relationships = new Map();

  for (const relationship of parsed?.Relationships?.Relationship ?? []) {
    const id = asText(relationship?.Id).trim();
    const external = asText(relationship?.TargetMode).trim().toLowerCase() === "external";

    // The first of two relationships with one Id is the one an OPC reader keeps.
    if (id && !relationships.has(id)) {
      relationships.set(id, {
        target: external ? null : resolvePackageTarget(relationship?.Target, workbookDirectory),
        type: asText(relationship?.Type).trim(),
      });
    }
  }

  return relationships;
};

// SheetJS reads a worksheet as one character per byte and finds its parts
// with regular expressions; the scan below reads the bytes the way these do,
// without copying the part into a string:
//   cells          /<(?:\w+:)?c[ \/>]/   one cell at most per match
//   row ends       /<\/(?:\w+:)?row>/    a row may yield one cell before its
//                                        first cell element
//   merged ranges  <(?:\w+:)?mergeCell   one range object each
//   hyperlinks     /<(?:\w+:)?hyperlink [^<>]*>/  SheetJS gives every cell of
//                  a hyperlink's range a stub, so one hyperlink over the
//                  whole sheet is some 17 billion objects; the pages never
//                  use hyperlinks, so the tag is renamed and none is found.
const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const SLASH = 0x2f;
const COLON = 0x3a;
const SPACE = 0x20;
const LETTER_C = 0x63;
const HYPERLINK_RENAME = Buffer.from("-not-read", "latin1");

// \w over one byte.
const isWordByte = (byte) =>
  (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f;

// \s over one byte read as a latin1 character.
const isSpaceByte = (byte) => byte === SPACE || (byte >= 0x09 && byte <= 0x0d) || byte === 0xa0;

const wordEnd = (buffer, start) => {
  let end = start;

  while (end < buffer.length && isWordByte(buffer[end])) {
    end += 1;
  }

  return end;
};

// The name of the tag whose "<" is at `index`, as the patterns above read
// it: whether it closes, and its local name's [start, end) after an
// optional "prefix:" (one or more word characters, then a colon).
const readTagName = (buffer, index) => {
  const closing = buffer[index + 1] === SLASH;
  const start = closing ? index + 2 : index + 1;
  const end = wordEnd(buffer, start);

  if (end > start && buffer[end] === COLON) {
    return { closing, localEnd: wordEnd(buffer, end + 1), localStart: end + 1 };
  }

  return { closing, localEnd: end, localStart: start };
};

const isLocalName = (buffer, start, end, name) =>
  end - start === name.length && buffer.toString("latin1", start, end) === name;

/**
 * A worksheet part as SheetJS will be given it: { bytes, cellElements }.
 * UTF-16 (a byte order mark, or a "<?" start, as decodeXmlPart reads it) is
 * written out as UTF-8, so the count below and SheetJS read the same
 * characters (SheetJS decodes UTF-16 with a byte order mark itself, which a
 * count over the raw bytes would miss); a part that would still start the
 * way SheetJS takes for UTF-16 is refused (400 DOCUMENT_ARCHIVE_INVALID).
 * Hyperlink tags are renamed. cellElements is an upper bound of the cells
 * and merged ranges SheetJS creates from the part.
 */
export const prepareWorksheetPart = (buffer) => {
  const isUtf16 =
    (buffer[0] === 0xff && buffer[1] === 0xfe) ||
    (buffer[0] === 0xfe && buffer[1] === 0xff) ||
    (buffer[0] === 0x3c && buffer[1] === 0x00 && buffer[2] === 0x3f && buffer[3] === 0x00) ||
    (buffer[0] === 0x00 && buffer[1] === 0x3c && buffer[2] === 0x00 && buffer[3] === 0x3f);
  const utf8 = isUtf16 ? Buffer.from(decodeXmlPart(buffer), "utf8") : buffer;

  if ((utf8[0] === 0xff && utf8[1] === 0xfe) || (utf8[1] === 0xfe && utf8[2] === 0xff)) {
    throw createArchiveInvalidError("a worksheet's encoding cannot be read");
  }

  const hyperlinkNameEnds = [];
  let cellElements = 1;

  for (let index = utf8.indexOf(LESS_THAN); index !== -1; index = utf8.indexOf(LESS_THAN, index + 1)) {
    const { closing, localEnd, localStart } = readTagName(utf8, index);
    const next = utf8[localEnd];

    if (closing) {
      if (next === GREATER_THAN && isLocalName(utf8, localStart, localEnd, "row")) {
        cellElements += 1;
      }
    } else if (localEnd - localStart === 1 && utf8[localStart] === LETTER_C) {
      if (next === SPACE || next === SLASH || next === GREATER_THAN) {
        cellElements += 1;
      }
    } else if (isLocalName(utf8, localStart, localEnd, "mergeCell")) {
      if (isSpaceByte(next) || next === SLASH || next === GREATER_THAN) {
        cellElements += 1;
      }
    } else if (next === SPACE && isLocalName(utf8, localStart, localEnd, "hyperlink")) {
      hyperlinkNameEnds.push(localEnd);
    }
  }

  if (hyperlinkNameEnds.length === 0) {
    return { bytes: utf8, cellElements };
  }

  const pieces = [];
  let from = 0;

  for (const end of hyperlinkNameEnds) {
    pieces.push(utf8.subarray(from, end), HYPERLINK_RENAME);
    from = end;
  }

  pieces.push(utf8.subarray(from));

  return { bytes: Buffer.concat(pieces), cellElements };
};

/**
 * The parts of a .xlsx the rebuilt workbook is made of, from the guard's scan
 * (`archive`): { workbook, relationships, sharedStrings, styles } -- the
 * workbook part's bytes, its relationships (readWorkbookRelationships), and
 * the bytes of the shared strings and styles parts its relationships name,
 * else the first [Content_Types].xml override of their content type, as
 * SheetJS found them (null when there are none). The styles are read by the
 * first SheetJS pass and never handed over as they are (buildStylesXml).
 * Refuses (400 DOCUMENT_ARCHIVE_INVALID) a
 * package holding another spreadsheet format's parts, and (413
 * DOCUMENT_ARCHIVE_TOO_LARGE) a workbook, relationships, shared strings or
 * styles part over RAG_OFFICE_MAX_XML_BYTES (`maxXmlBytes`): SheetJS holds
 * each whole. Worksheets are bounded by preparing them (prepareWorksheets).
 */
export const readWorkbookParts = async (archive, { maxXmlBytes = getOfficeMaxXmlBytes() } = {}) => {
  const lowerNames = new Set(archive.fileNames.map((name) => name.toLowerCase()));

  if (FOREIGN_SPREADSHEET_PARTS.some((name) => lowerNames.has(name))) {
    throw createArchiveInvalidError("the workbook holds parts of another spreadsheet format");
  }

  const workbookName = archive.package?.mainPart?.name;

  if (!workbookName) {
    throw createArchiveInvalidError("the package does not name its main part");
  }

  const workbookDirectory = path.posix.dirname(workbookName) === "." ? "" : path.posix.dirname(workbookName);
  const relationshipsName = `${workbookDirectory ? `${workbookDirectory}/` : ""}_rels/${path.posix.basename(workbookName)}.rels`;

  assertXmlPartWithinLimit(archive, workbookName, maxXmlBytes);
  assertXmlPartWithinLimit(archive, relationshipsName, maxXmlBytes);

  const workbook = await archive.readPart(workbookName);

  if (!workbook) {
    throw createArchiveInvalidError("the main document part is missing");
  }

  const relationshipsXml = await archive.readPart(relationshipsName);
  const relationships = relationshipsXml ? readWorkbookRelationships(relationshipsXml, workbookDirectory) : null;
  // The part the workbook's relationships name, else (as SheetJS looked for
  // them) the first [Content_Types].xml override of its content type.
  const readRelatedPart = async (kind) => {
    const related = [...(relationships?.values() ?? [])].find(
      (relationship) => relationship.target && relationshipKind(relationship.type) === kind
    );
    const target = related?.target ?? findContentTypeOverride(archive, RELATED_PART_CONTENT_TYPES[kind]);

    if (!target) {
      return null;
    }

    assertXmlPartWithinLimit(archive, target, maxXmlBytes);
    return archive.readPart(target);
  };

  return {
    relationships,
    sharedStrings: await readRelatedPart("sharedStrings"),
    styles: await readRelatedPart("styles"),
    workbook,
  };
};

/**
 * The worksheets of the visible sheets, ready for SheetJS. `sheets` is the
 * workbook's sheet list as SheetJS reads it ([{ id, hidden }], workbook
 * order). A sheet's part is the one its relationship names; as SheetJS does,
 * every sheet falls back to xl/worksheets/sheet<N>.xml when the workbook has
 * no relationships or one of its sheets has none. Hidden sheets, chart,
 * dialog and macro sheets and sheets whose part is missing are left out
 * (they gave no page before either). Returns [{ index, bytes }] (index: the
 * 0-based workbook position) and refuses (413 DOCUMENT_SPREADSHEET_TOO_LARGE)
 * more than XLSX_CELL_PRECHECK_FACTOR x `maxCells` cell elements in all.
 */
export const prepareWorksheets = async (archive, { relationships, sheets }, { maxCells = getXlsxMaxCells() } = {}) => {
  const useDefaultPaths = !relationships || sheets.some((sheet) => !sheet.id || !relationships.has(sheet.id));
  // SheetJS's allowance for workbooks Numbers wrote: sheet.xml for the first.
  const numbersOffset = useDefaultPaths && archive.partSizes.has("xl/worksheets/sheet.xml") ? 1 : 0;
  const prepared = [];
  let cellElements = 0;

  for (const [index, sheet] of sheets.entries()) {
    if (sheet.hidden) {
      continue;
    }

    let part;

    if (useDefaultPaths) {
      part = `xl/worksheets/sheet${index + 1 - numbersOffset}.xml`.replace(/sheet0\./, "sheet.");
    } else {
      const relationship = relationships.get(sheet.id);

      if (relationship.type && !WORKSHEET_RELATIONSHIP_TYPES.includes(relationship.type)) {
        continue;
      }

      part = relationship.target;
    }

    const bytes = part ? await archive.readPart(part) : null;

    if (!bytes) {
      continue;
    }

    const worksheet = prepareWorksheetPart(bytes);

    cellElements += worksheet.cellElements;

    if (cellElements > XLSX_CELL_PRECHECK_FACTOR * maxCells) {
      throw createSpreadsheetTooLargeError(maxCells);
    }

    prepared.push({ bytes: worksheet.bytes, index });
  }

  return prepared;
};

// ---------------------------------------------------------------------------
// The parts this module writes for the rebuilt workbook
// ---------------------------------------------------------------------------

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const SPREADSHEET_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml";

export const REBUILT_PARTS = Object.freeze({
  contentTypes: "[Content_Types].xml",
  relationships: "xl/_rels/workbook.xml.rels",
  sharedStrings: "xl/sharedStrings.xml",
  styles: "xl/styles.xml",
  workbook: "xl/workbook.xml",
  worksheet: (position) => `xl/worksheets/sheet${position + 1}.xml`,
});

const escapeXmlAttribute = (value) =>
  String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** The rebuilt workbook's [Content_Types].xml. */
export const buildContentTypesXml = ({ sharedStrings = false, styles = false, worksheets = 0 } = {}) =>
  Buffer.from(
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/${REBUILT_PARTS.workbook}" ContentType="${SPREADSHEET_CONTENT_TYPE}.sheet.main+xml"/>` +
      Array.from(
        { length: worksheets },
        (_, position) =>
          `<Override PartName="/${REBUILT_PARTS.worksheet(position)}" ContentType="${SPREADSHEET_CONTENT_TYPE}.worksheet+xml"/>`
      ).join("") +
      (sharedStrings
        ? `<Override PartName="/${REBUILT_PARTS.sharedStrings}" ContentType="${SPREADSHEET_CONTENT_TYPE}.sharedStrings+xml"/>`
        : "") +
      (styles ? `<Override PartName="/${REBUILT_PARTS.styles}" ContentType="${SPREADSHEET_CONTENT_TYPE}.styles+xml"/>` : "") +
      "</Types>",
    "utf8"
  );

// An attribute value (a sheet name, a number format) written so SheetJS
// reads back exactly `value`: it decodes the five XML entities and numeric
// references, then every _xHHHH_ escape, so an "_" that starts such a
// sequence in the value is itself written as _x005F_.
const encodeSheetjsAttribute = (value) =>
  escapeXmlAttribute(String(value).replace(/_(?=x[0-9a-f]{4}_)/gi, "_x005F_"));

/** The rebuilt workbook part: the sheets by `names`, in order, and date1904. */
export const buildWorkbookXml = ({ date1904 = false, names = [] } = {}) =>
  Buffer.from(
    `${XML_DECLARATION}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      (date1904 ? '<workbookPr date1904="1"/>' : "") +
      `<sheets>${names
        .map((name, position) => `<sheet name="${encodeSheetjsAttribute(name)}" sheetId="${position + 1}" r:id="rId${position + 1}"/>`)
        .join("")}</sheets></workbook>`,
    "utf8"
  );

/**
 * The rebuilt workbook's styles: only what SheetJS formats cells with -- the
 * number formats by id (`numberFormats`, as SheetJS read them from the
 * workbook's own styles, ids above its table's 392 slots left out: SheetJS
 * moves those into free slots, and `cellFormats` already names the slot) and
 * one cell format per original index (`cellFormats`: each one's numFmtId,
 * null for none). `implicitFormats` adds the formats SheetJS would load only
 * when a cell uses an id the workbook leaves undefined, so every cell carries
 * its format string (cellNF) and is formatted later, one at a time. Fonts,
 * fills, borders and anything else of the original styles never reach the
 * second pass. Null when there is nothing to write.
 */
export const buildStylesXml = ({ cellFormats = null, implicitFormats = {}, numberFormats = null } = {}) => {
  const formats = new Map();

  for (const [key, code] of Object.entries(numberFormats ?? {})) {
    const id = Number(key);

    if (Number.isInteger(id) && id > 0 && id <= 0x188 && typeof code === "string") {
      formats.set(id, code);
    }
  }

  for (const id of cellFormats ?? []) {
    if (Number.isInteger(id) && !formats.has(id) && typeof implicitFormats[id] === "string") {
      formats.set(id, implicitFormats[id]);
    }
  }

  if (formats.size === 0 && !Array.isArray(cellFormats)) {
    return null;
  }

  const numberFormatsXml =
    formats.size > 0
      ? `<numFmts count="${formats.size}">${[...formats]
          .map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${encodeSheetjsAttribute(code)}"/>`)
          .join("")}</numFmts>`
      : "";
  const cellFormatsXml = Array.isArray(cellFormats)
    ? `<cellXfs count="${cellFormats.length}">${cellFormats
        .map((id) => (id === null || id === undefined ? "<xf/>" : `<xf numFmtId="${escapeXmlAttribute(id)}"/>`))
        .join("")}</cellXfs>`
    : "";

  return Buffer.from(
    `${XML_DECLARATION}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `${numberFormatsXml}${cellFormatsXml}</styleSheet>`,
    "utf8"
  );
};

/** The rebuilt workbook's relationships: rId<N> to the N-th worksheet. */
export const buildWorkbookRelationshipsXml = (worksheets) =>
  Buffer.from(
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      Array.from(
        { length: worksheets },
        (_, position) =>
          `<Relationship Id="rId${position + 1}" Type="${WORKSHEET_RELATIONSHIP_TYPES[0]}" Target="worksheets/sheet${position + 1}.xml"/>`
      ).join("") +
      "</Relationships>",
    "utf8"
  );
