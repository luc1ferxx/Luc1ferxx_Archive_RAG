import { XMLParser, XMLValidator } from "fast-xml-parser";

import { getOfficeMaxTextChars } from "../config.js";
import { createArchiveInvalidError } from "../document-format-errors.js";
import { buildHeaderLabels, createTextBudget, formatLabelledRow, formatPlainRow } from "./table-text.js";
import { MAX_OFFICE_XML_NESTING } from "./xml-nesting.js";
import { decodeXmlPart } from "./zip-guard.js";

// PowerPoint (.pptx) text extraction for the Office ingest path.
//
// The archive guard opens the ZIP and hands over its entries as a Map of entry
// name (no leading slash) -> Buffer. This module reads the presentation part,
// follows p:sldIdLst through the presentation's relationships to the slides in
// deck order, reads each visible slide and its speaker notes, and returns one
// page per visible slide that has any text, in the shape every loader returns:
//
//   { pageNumber, text, locationUnit: "slide", locationLabel? }
//
// pageNumber is the slide's 1-based position in the deck, hidden slides
// included, so a citation's slide number is the one PowerPoint shows.
// locationLabel is the slide title and is absent (not undefined) without one.
//
// Bump PPTX_EXTRACTOR_VERSION whenever the text or the page numbers change for
// the same bytes: it is part of the chunk profile of PowerPoint chunks, so the
// stored chunks say which reader cut them, and feedback records and workspace
// artifacts persist the page numbers.
//   1  the first reader.
//   2  a slide paragraph's bullet follows PowerPoint's inheritance (its own
//      a:pPr, its shape's list style, the matching placeholders of the
//      slide's layout and master, the master's text styles), so the body
//      text of an ordinary content slide, which takes its bullets from the
//      master, now reads as "- " list lines.
export const PPTX_EXTRACTOR_VERSION = 2;

// Namespaces, matched by URI rather than by prefix: the prefixes are only the
// conventional ones ("p", "a", "r"), and ISO 29500 Strict files use other URIs
// under the same content types.
const PRESENTATIONML = new Set([
  "http://schemas.openxmlformats.org/presentationml/2006/main",
  "http://purl.oclc.org/ooxml/presentationml/main",
]);
const DRAWINGML = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
]);
const OFFICE_RELATIONSHIPS = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const PACKAGE_RELATIONSHIPS = new Set([
  "http://schemas.openxmlformats.org/package/2006/relationships",
]);
const MARKUP_COMPATIBILITY = new Set([
  "http://schemas.openxmlformats.org/markup-compatibility/2006",
]);
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

const DEFAULT_PRESENTATION_PART = "ppt/presentation.xml";
const PACKAGE_RELATIONSHIPS_PART = "_rels/.rels";

const TITLE_PLACEHOLDER_TYPES = new Set(["title", "ctrTitle"]);
// Slide number, date and footer placeholders repeat on every slide and say
// nothing about it; a notes page also carries a picture of its slide.
const SLIDE_SKIPPED_PLACEHOLDER_TYPES = new Set(["sldNum", "dt", "ftr"]);
const NOTES_SKIPPED_PLACEHOLDER_TYPES = new Set(["sldNum", "dt", "ftr", "sldImg"]);
// A placeholder element without a type attribute is an object placeholder
// (ST_PlaceholderType's default).
const DEFAULT_PLACEHOLDER_TYPE = "obj";

const NOTES_HEADING = "Notes:";
const LIST_MARKER = "- ";

// Generous for slides (a table inside a few nested groups stays well under
// 40 levels) and low enough that the recursive walks below cannot exhaust the
// stack on a hostile part, on the main thread or a worker: the parser refuses
// deeper nesting. The same cap as a Word document's (xml-nesting.js).
const MAX_XML_NESTING = MAX_OFFICE_XML_NESTING;

const DOCUMENT_TYPE_DECLARATION = /<!DOCTYPE|<!ENTITY/i;

// Why a deck cannot be read, worded like the archive guard's refusals: fixed
// text that never quotes the file (no part names, no slide text).
const REASONS = Object.freeze({
  missingPresentation: "it has no presentation part",
  missingPresentationRelationships: "its presentation part has no relationships",
  notPresentation: "its presentation part is not a PowerPoint presentation",
  notRelationships: "a relationship part is not valid",
  missingPart: "a slide or notes page it refers to is missing",
  unresolvedReference: "it refers to a slide or notes page that cannot be resolved",
  wrongPartKind: "a part it refers to as a slide or notes page is something else",
  duplicateReference: "it refers to the same slide or notes page more than once",
  ambiguousPartName: "two parts have names that differ only in case",
  notWellFormed: "an XML part is not well-formed",
  documentTypeDeclaration: "an XML part declares a DTD",
});

// 400 DOCUMENT_ARCHIVE_INVALID. `cause` keeps the parser's own error, whose
// message may quote the part, out of the message.
const archiveError = (reason, cause) =>
  createArchiveInvalidError(reason, cause === undefined ? {} : { cause });

// ---------------------------------------------------------------------------
// XML reading
//
// fast-xml-parser runs with entity processing off: OOXML needs no DTD (the
// archive guard refuses one, and parseXmlDocument below refuses it again), so
// the only references a part can hold are the five predefined entities and
// character references, which decodeXmlText resolves in one pass. Nothing else
// is ever expanded. preserveOrder keeps runs, paragraphs and shapes in
// document order; trimValues is off because the spaces at the ends of a run
// separate it from the next one; values are never converted, so a run reading
// "007" stays that text and not the number 7.
// ---------------------------------------------------------------------------

const TEXT_KEY = "#text";
const CDATA_KEY = "#cdata";
const ATTRIBUTES_KEY = ":@";

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  // CDATA is kept apart from text so that its content is never decoded.
  cdataPropName: CDATA_KEY,
  stopNodes: [],
  maxNestedTags: MAX_XML_NESTING,
  jPath: false,
});

const PREDEFINED_ENTITIES = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
});
const XML_REFERENCE = /&(?:#([0-9]+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;

// The characters XML 1.0 allows (the Char production).
const isXmlCharacter = (codePoint) =>
  codePoint === 0x9 ||
  codePoint === 0xa ||
  codePoint === 0xd ||
  (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
  (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
  (codePoint >= 0x10000 && codePoint <= 0x10ffff);

// One pass, so "&amp;lt;" becomes the text "&lt;" and never "<". A character
// reference to a code point XML does not allow (NUL, a lone surrogate, past
// U+10FFFF) becomes a space: such a character cannot be stored as text in
// PostgreSQL or JSON, and the reference is not well-formed XML anyway.
const decodeXmlText = (value) =>
  value.includes("&")
    ? value.replace(XML_REFERENCE, (reference, decimal, hexadecimal, name) => {
        if (name !== undefined) {
          return PREDEFINED_ENTITIES[name];
        }

        const codePoint =
          decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hexadecimal, 16);

        return isXmlCharacter(codePoint) ? String.fromCodePoint(codePoint) : " ";
      })
    : value;

const tagNameOf = (node) => Object.keys(node).find((key) => key !== ATTRIBUTES_KEY);

// A prefix the part never declared is a namespace well-formedness error; the
// part is refused rather than read with its elements silently unmatched.
const resolveQualifiedName = (qualifiedName, scope, isAttribute) => {
  const colon = qualifiedName.indexOf(":");

  if (colon === -1) {
    // The default namespace applies to elements only.
    return {
      namespace: isAttribute ? null : scope.get("") || null,
      local: qualifiedName,
    };
  }

  const prefix = qualifiedName.slice(0, colon);
  const local = qualifiedName.slice(colon + 1);

  if (prefix === "xml") {
    return { namespace: XML_NAMESPACE, local };
  }

  const namespace = scope.get(prefix);

  if (!namespace) {
    throw archiveError(REASONS.notWellFormed);
  }

  return { namespace, local };
};

// The parser's ordered output as plain elements whose names carry their
// namespace URI: { namespace, local, attributes: [{ namespace, local, value }],
// children: [element | { text }] }. Text and attribute values are decoded here.
const buildElement = (node, qualifiedName, inheritedScope) => {
  const rawAttributes = node[ATTRIBUTES_KEY] ?? {};
  let scope = inheritedScope;
  const declaredAttributes = [];

  for (const [name, rawValue] of Object.entries(rawAttributes)) {
    const value = decodeXmlText(String(rawValue));

    if (name === "xmlns" || name.startsWith("xmlns:")) {
      if (scope === inheritedScope) {
        scope = new Map(inheritedScope);
      }

      scope.set(name === "xmlns" ? "" : name.slice("xmlns:".length), value);
      continue;
    }

    declaredAttributes.push({ name, value });
  }

  const { namespace, local } = resolveQualifiedName(qualifiedName, scope, false);
  const attributes = declaredAttributes.map(({ name, value }) => ({
    ...resolveQualifiedName(name, scope, true),
    value,
  }));
  const children = [];

  for (const child of node[qualifiedName] ?? []) {
    const childName = tagNameOf(child);

    if (childName === TEXT_KEY) {
      children.push({ text: decodeXmlText(String(child[TEXT_KEY])) });
    } else if (childName === CDATA_KEY) {
      children.push({
        text: (child[CDATA_KEY] ?? []).map((piece) => String(piece[TEXT_KEY] ?? "")).join(""),
      });
    } else if (childName !== undefined) {
      children.push(buildElement(child, childName, scope));
    }
  }

  return { namespace, local, attributes, children };
};

// `text` is the part as the archive guard's decodeXmlPart reads it (UTF-8, or
// UTF-16 with a byte order mark or an "<?" start), so this reader parses the
// text the guard checked.
const parseXmlDocument = (text) => {
  // OOXML never needs a DTD; refusing one keeps entity expansion out entirely.
  // The archive guard already refuses a part with one; this keeps the reader
  // safe on its own, whoever built the parts Map.
  if (DOCUMENT_TYPE_DECLARATION.test(text)) {
    throw archiveError(REASONS.documentTypeDeclaration);
  }

  // The parser itself tolerates mismatched and unclosed tags, which would let a
  // truncated part pass as a shorter slide.
  if (XMLValidator.validate(text) !== true) {
    throw archiveError(REASONS.notWellFormed);
  }

  let ordered;

  try {
    ordered = xmlParser.parse(text);
  } catch (error) {
    throw archiveError(REASONS.notWellFormed, error);
  }

  // Exactly one root element: the validator lets a second, self-closing root
  // through.
  const rootNodes = (ordered ?? []).filter((node) => {
    const name = tagNameOf(node);
    return name !== undefined && name !== TEXT_KEY && name !== CDATA_KEY;
  });

  if (rootNodes.length !== 1) {
    throw archiveError(REASONS.notWellFormed);
  }

  const [rootNode] = rootNodes;
  return buildElement(rootNode, tagNameOf(rootNode), new Map());
};

const isElement = (node, namespaces, local) =>
  Boolean(node) && node.local === local && namespaces.has(node.namespace) && Array.isArray(node.children);

// mc:AlternateContent offers one or more mc:Choice branches and a fallback.
// The first Choice is what PowerPoint itself renders and carries the text
// (equations, newer shape features); the Fallback is usually a picture of it.
// Reading both would repeat the text.
const chooseAlternateContentBranch = (alternateContent) => {
  const branches = alternateContent.children.filter((child) => child.children);

  return (
    branches.find((child) => isElement(child, MARKUP_COMPATIBILITY, "Choice")) ??
    branches.find((child) => isElement(child, MARKUP_COMPATIBILITY, "Fallback")) ??
    null
  );
};

// An element's child elements, with every mc:AlternateContent replaced by the
// children of its chosen branch.
const childElements = (element) => {
  const result = [];

  for (const child of element?.children ?? []) {
    if (!child.children) {
      continue;
    }

    if (isElement(child, MARKUP_COMPATIBILITY, "AlternateContent")) {
      const branch = chooseAlternateContentBranch(child);

      // One push per element, never push(...list): a spread passes every
      // element as an argument, and a branch with more than about 125,000
      // children would overflow the stack (an uncoded RangeError, retried
      // as a 500 by the ingest queue).
      for (const element of branch ? childElements(branch) : []) {
        result.push(element);
      }

      continue;
    }

    result.push(child);
  }

  return result;
};

const firstChildElement = (element, namespaces, local) =>
  childElements(element).find((child) => isElement(child, namespaces, local)) ?? null;

// namespaces null: an unprefixed attribute (attributes take no default
// namespace).
const getAttribute = (element, local, namespaces = null) => {
  for (const attribute of element?.attributes ?? []) {
    if (
      attribute.local === local &&
      (namespaces === null ? attribute.namespace === null : namespaces.has(attribute.namespace))
    ) {
      return attribute.value;
    }
  }

  return null;
};

const textContent = (element) =>
  (element?.children ?? []).map((child) => (child.children ? "" : child.text)).join("");

// ---------------------------------------------------------------------------
// Package parts and relationships
// ---------------------------------------------------------------------------

const AMBIGUOUS_PART = Symbol("ambiguous part name");

// OPC part names compare case-insensitively, and relationship targets may be
// percent-encoded; the exact entry name is tried first.
const createPartLookup = (parts) => {
  if (!(parts instanceof Map)) {
    throw new TypeError("extractPptxPages expects a Map of ZIP entry names to Buffers.");
  }

  const folded = new Map();

  for (const name of parts.keys()) {
    const key = String(name).toLowerCase();
    folded.set(key, folded.has(key) ? AMBIGUOUS_PART : name);
  }

  const find = (name) => {
    if (parts.has(name)) {
      return name;
    }

    const match = folded.get(name.toLowerCase());

    if (match === AMBIGUOUS_PART) {
      throw archiveError(REASONS.ambiguousPartName);
    }

    return match ?? null;
  };

  return (partName) => {
    let name = find(partName);

    if (name === null && partName.includes("%")) {
      let decoded = null;

      try {
        decoded = decodeURIComponent(partName);
      } catch {
        decoded = null;
      }

      if (decoded !== null && decoded !== partName) {
        name = find(decoded);
      }
    }

    if (name === null) {
      return null;
    }

    const data = parts.get(name);

    if (!(data instanceof Uint8Array)) {
      throw new TypeError("extractPptxPages expects every part to be a Buffer.");
    }

    return { name, data };
  };
};

const parseXmlPart = (part) => ({ name: part.name, root: parseXmlDocument(decodeXmlPart(part.data)) });

const readXmlPart = (findPart, partName) => {
  const part = findPart(partName);
  return part ? parseXmlPart(part) : null;
};

const folderOf = (partName) => {
  const slash = partName.lastIndexOf("/");
  return slash === -1 ? "" : partName.slice(0, slash);
};

// "ppt/slides/slide1.xml" -> "ppt/slides/_rels/slide1.xml.rels"; the package
// itself (source "") -> "_rels/.rels".
const relationshipsPartNameOf = (sourcePartName) => {
  if (sourcePartName === "") {
    return PACKAGE_RELATIONSHIPS_PART;
  }

  const folder = folderOf(sourcePartName);
  const fileName = sourcePartName.slice(folder ? folder.length + 1 : 0);

  return `${folder ? `${folder}/` : ""}_rels/${fileName}.rels`;
};

// A relationship target as a ZIP entry name: relative to the source part's
// folder, or from the package root when it starts with "/". Null when it climbs
// above the root or names nothing.
const resolveTargetPartName = (sourcePartName, target) => {
  const value = String(target ?? "").trim();

  if (!value) {
    return null;
  }

  const absolute = value.startsWith("/");
  const base = absolute ? [] : folderOf(sourcePartName).split("/").filter(Boolean);
  const segments = [...base];

  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }

      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.length > 0 ? segments.join("/") : null;
};

// The last segment of a relationship type URI ("slide", "notesSlide",
// "officeDocument"), the same under the transitional and the Strict URIs.
const relationshipKind = (type) => {
  const value = String(type ?? "").trim();
  return value.slice(value.lastIndexOf("/") + 1);
};

// The relationships of one part, in document order. External targets (a
// hyperlink, a linked file) are kept as such and never resolved into a part:
// nothing is read from outside the archive.
const readRelationships = (findPart, sourcePartName) => {
  const document = readXmlPart(findPart, relationshipsPartNameOf(sourcePartName));

  if (!document) {
    return null;
  }

  if (!isElement(document.root, PACKAGE_RELATIONSHIPS, "Relationships")) {
    throw archiveError(REASONS.notRelationships);
  }

  const list = [];
  const byId = new Map();

  for (const element of childElements(document.root)) {
    if (!isElement(element, PACKAGE_RELATIONSHIPS, "Relationship")) {
      continue;
    }

    const id = (getAttribute(element, "Id") ?? "").trim();
    const external = (getAttribute(element, "TargetMode") ?? "").trim().toLowerCase() === "external";
    const relationship = {
      id,
      kind: relationshipKind(getAttribute(element, "Type")),
      external,
      targetPartName: external ? null : resolveTargetPartName(sourcePartName, getAttribute(element, "Target")),
    };

    list.push(relationship);

    // Ids are unique in a valid package; the first one wins otherwise.
    if (id && !byId.has(id)) {
      byId.set(id, relationship);
    }
  }

  return { list, byId };
};

// The main part is the package's officeDocument relationship (the loader
// passes the one the archive guard classified, so both read the same part). A
// parts map without the package relationships part uses the conventional
// name.
const findPresentationPartName = (findPart) => {
  const packageRelationships = readRelationships(findPart, "");
  const officeDocument = packageRelationships?.list.find(
    (relationship) => relationship.kind === "officeDocument" && !relationship.external && relationship.targetPartName
  );

  return officeDocument?.targetPartName ?? DEFAULT_PRESENTATION_PART;
};

// ---------------------------------------------------------------------------
// Slide content
// ---------------------------------------------------------------------------

const ILLEGAL_TEXT_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

// One paragraph is one line: every whitespace run, line breaks included,
// becomes a single space. Control characters XML does not allow (a lenient
// writer may still emit them) become spaces too.
const normalizeLine = (value) => value.replace(ILLEGAL_TEXT_CHARACTERS, " ").replace(/\s+/g, " ").trim();

const BULLET_ELEMENTS = ["buChar", "buAutoNum", "buBlip"];
const LIST_LEVEL_PROPERTIES = /^lvl([1-9])pPr$/;

// What paragraph properties (a:pPr, a:lvlNpPr, a:defPPr) say about a bullet:
// "bullet" (a:buChar, a:buAutoNum, a:buBlip), "none" (a:buNone), or null when
// they leave it to the level they inherit from.
const readBulletSetting = (properties) => {
  for (const child of childElements(properties)) {
    if (isElement(child, DRAWINGML, "buNone")) {
      return "none";
    }

    if (BULLET_ELEMENTS.some((local) => isElement(child, DRAWINGML, local))) {
      return "bullet";
    }
  }

  return null;
};

// A list style (a:lstStyle, or one of a master's p:txStyles) as level (1-9)
// -> bullet setting: the level's own a:lvlNpPr, else the style's a:defPPr.
// Null without a list style.
const readListStyle = (listStyle) => {
  if (!listStyle) {
    return null;
  }

  const levels = new Map();
  let defaults = null;

  for (const child of childElements(listStyle)) {
    if (!DRAWINGML.has(child.namespace)) {
      continue;
    }

    if (child.local === "defPPr") {
      defaults = readBulletSetting(child);
      continue;
    }

    const match = LIST_LEVEL_PROPERTIES.exec(child.local);

    if (match) {
      levels.set(Number(match[1]), readBulletSetting(child));
    }
  }

  return (level) => levels.get(level) ?? defaults;
};

// { text, indented, level, bullet }: runs and fields joined as written, a:br
// (a line break inside the paragraph) as a space; indented whether it sits
// below the top outline level; level that outline level (0-8, the list style
// level it reads is level + 1); bullet what its own a:pPr says
// (readBulletSetting).
const readParagraph = (paragraph) => {
  const pieces = [];
  let properties = null;

  for (const child of childElements(paragraph)) {
    if (isElement(child, DRAWINGML, "pPr")) {
      properties ??= child;
    } else if (isElement(child, DRAWINGML, "r") || isElement(child, DRAWINGML, "fld")) {
      for (const textElement of childElements(child)) {
        if (isElement(textElement, DRAWINGML, "t")) {
          pieces.push(textContent(textElement));
        }
      }
    } else if (isElement(child, DRAWINGML, "br")) {
      pieces.push(" ");
    }
  }

  const level = Number(getAttribute(properties, "lvl"));
  const indented = Number.isFinite(level) && level > 0;

  return {
    text: normalizeLine(pieces.join("")),
    indented,
    level: indented ? Math.min(Math.floor(level), 8) : 0,
    bullet: readBulletSetting(properties),
  };
};

// The non-empty paragraphs of a p:txBody (a shape) or a:txBody (a table cell).
const readTextBody = (textBody) =>
  childElements(textBody)
    .filter((child) => isElement(child, DRAWINGML, "p"))
    .map(readParagraph)
    .filter((paragraph) => paragraph.text);

// A paragraph is a list item when it sits below the top outline level, or
// when the first of its list styles that says anything about a bullet --
// its own a:pPr, then `listStyles` in order (the shape's own, then the
// inherited ones) -- names one rather than a:buNone. That is how PowerPoint
// draws it: the body text of an ordinary content slide carries no bullet of
// its own and takes the master's.
const isListParagraph = (paragraph, listStyles) => {
  if (paragraph.indented) {
    return true;
  }

  let setting = paragraph.bullet;

  for (const listStyle of listStyles) {
    if (setting !== null) {
      break;
    }

    setting = listStyle ? listStyle(paragraph.level + 1) : null;
  }

  return setting === "bullet";
};

const isTrue = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true";
};

// A table row's cells as { column, text, span }, without the continuation
// cells of a merge: PowerPoint writes one a:tc per grid column, flags the
// cells a merge covers (hMerge, vMerge) and shows the merged text in the first
// one. span counts the columns a cell covers to its right (itself plus the
// hMerge cells after it), which is what PowerPoint draws whatever gridSpan
// says.
const readTableRow = (row) => {
  const cells = [];

  childElements(row)
    .filter((child) => isElement(child, DRAWINGML, "tc"))
    .forEach((cell, column) => {
      if (isTrue(getAttribute(cell, "hMerge"))) {
        if (cells.length > 0 && cells.at(-1).column + cells.at(-1).span === column) {
          cells.at(-1).span += 1;
        }

        return;
      }

      if (isTrue(getAttribute(cell, "vMerge"))) {
        return;
      }

      cells.push({
        column,
        span: 1,
        text: normalizeLine(
          readTextBody(firstChildElement(cell, DRAWINGML, "txBody"))
            .map((paragraph) => paragraph.text)
            .join(" ")
        ),
      });
    });

  return cells;
};

// One line per row, the way every Office loader writes a table (table-text.js):
// the first row is the header, written as a plain line (so a one-row table
// keeps its text), and labels the non-empty cells of every later row
// ("Header: value; Header: value"); a header merged across columns labels each
// of them, and a cell under an empty header -- or one too long to be a label
// -- is labelled by its column letter. The lines are spent from `budget` as
// they are written, since labels repeat on every row.
const readTableLines = (table, budget) => {
  const [headerRow, ...bodyRows] = childElements(table)
    .filter((child) => isElement(child, DRAWINGML, "tr"))
    .map(readTableRow);

  if (!headerRow) {
    return [];
  }

  const headerLabels = buildHeaderLabels(headerRow);
  const lines = [];
  const addLine = (line) => {
    if (line) {
      budget.spend(line.length + 1);
      lines.push(line);
    }
  };

  addLine(formatPlainRow(headerRow));

  for (const cells of bodyRows) {
    addLine(formatLabelledRow(cells, headerLabels));
  }

  return lines;
};

// { type, idx } of a shape's p:ph -- type the default for a p:ph without one,
// idx null without one -- or null for a shape that is not a placeholder.
// nonVisualProperties is p:nvSpPr / p:nvGraphicFramePr.
const readPlaceholder = (nonVisualProperties) => {
  const placeholder = firstChildElement(
    firstChildElement(nonVisualProperties, PRESENTATIONML, "nvPr"),
    PRESENTATIONML,
    "ph"
  );

  if (!placeholder) {
    return null;
  }

  return {
    idx: (getAttribute(placeholder, "idx") ?? "").trim() || null,
    type: (getAttribute(placeholder, "type") ?? "").trim() || DEFAULT_PLACEHOLDER_TYPE,
  };
};

const EMU_PER_UNIT = Object.freeze({
  mm: 36000,
  cm: 360000,
  in: 914400,
  pt: 12700,
  pc: 152400,
  pi: 152400,
});
const UNIVERSAL_MEASURE = /^(-?[0-9]+(?:\.[0-9]+)?)(mm|cm|in|pt|pc|pi)$/;

// ST_Coordinate: EMUs, or a universal measure ("2.5cm") in later editions.
const parseCoordinate = (value) => {
  const text = String(value ?? "").trim();

  if (/^-?[0-9]+$/.test(text)) {
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }

  const measure = UNIVERSAL_MEASURE.exec(text);
  return measure ? Number(measure[1]) * EMU_PER_UNIT[measure[2]] : null;
};

// { x, y } from a:off inside the given xfrm element, or null when the shape
// states no position of its own (a placeholder that inherits its layout's).
const readOffset = (transform) => {
  const offset = firstChildElement(transform, DRAWINGML, "off");

  if (!offset) {
    return null;
  }

  const x = parseCoordinate(getAttribute(offset, "x"));
  const y = parseCoordinate(getAttribute(offset, "y"));

  return x === null || y === null ? null : { x, y };
};

// `context`: { tableBudget, inheritedListStyles(placeholder) } (readShapeTree).
const describeTextShape = (shape, context) => {
  const textBody = firstChildElement(shape, PRESENTATIONML, "txBody");
  const paragraphs = readTextBody(textBody);
  const placeholder = readPlaceholder(firstChildElement(shape, PRESENTATIONML, "nvSpPr"));
  const listStyles =
    paragraphs.length > 0
      ? [readListStyle(firstChildElement(textBody, DRAWINGML, "lstStyle")), ...context.inheritedListStyles(placeholder)]
      : [];

  return {
    placeholderType: placeholder?.type ?? null,
    offset: readOffset(firstChildElement(firstChildElement(shape, PRESENTATIONML, "spPr"), DRAWINGML, "xfrm")),
    lines: paragraphs.map((paragraph) =>
      isListParagraph(paragraph, listStyles) ? `${LIST_MARKER}${paragraph.text}` : paragraph.text
    ),
    label: paragraphs.map((paragraph) => paragraph.text).join(" "),
  };
};

// Tables are the only graphic frame that adds text in this version; charts,
// SmartArt and embedded objects add nothing.
const describeGraphicFrame = (frame, context) => {
  const graphicData = firstChildElement(firstChildElement(frame, DRAWINGML, "graphic"), DRAWINGML, "graphicData");
  const table = firstChildElement(graphicData, DRAWINGML, "tbl");
  const lines = table ? readTableLines(table, context.tableBudget) : [];

  return {
    placeholderType: readPlaceholder(firstChildElement(frame, PRESENTATIONML, "nvGraphicFramePr"))?.type ?? null,
    offset: readOffset(firstChildElement(frame, PRESENTATIONML, "xfrm")),
    lines,
    label: lines.join(" "),
  };
};

// The text shapes of a shape tree (p:spTree or p:grpSp) in document order, with
// groups flattened. Pictures, connectors and content parts carry no text.
const collectShapes = (container, shapes, context) => {
  for (const child of childElements(container)) {
    if (isElement(child, PRESENTATIONML, "sp")) {
      shapes.push(describeTextShape(child, context));
    } else if (isElement(child, PRESENTATIONML, "graphicFrame")) {
      shapes.push(describeGraphicFrame(child, context));
    } else if (isElement(child, PRESENTATIONML, "grpSp")) {
      collectShapes(child, shapes, context);
    }
  }

  return shapes;
};

// The shapes of a slide or notes page with text, minus the skipped
// placeholders, each with its document position. `context.tableBudget` is
// spent by its tables; `context.inheritedListStyles(placeholder)` gives the
// list styles a shape's paragraphs inherit after the shape's own (none for a
// notes page).
const readShapeTree = (root, skippedPlaceholderTypes, context) => {
  const shapeTree = firstChildElement(firstChildElement(root, PRESENTATIONML, "cSld"), PRESENTATIONML, "spTree");

  return collectShapes(shapeTree, [], context)
    .map((shape, index) => ({ ...shape, index }))
    .filter((shape) => shape.lines.length > 0 && !skippedPlaceholderTypes.has(shape.placeholderType));
};

// ---------------------------------------------------------------------------
// Inherited list styles: slide layout and slide master
// ---------------------------------------------------------------------------

const TITLE_STYLE_PLACEHOLDER_TYPES = new Set(["title", "ctrTitle"]);
const OTHER_STYLE_PLACEHOLDER_TYPES = new Set(["dt", "ftr", "sldNum"]);

// The placeholders of a layout or master shape tree, groups included, each
// as { type, idx, listStyle }.
const collectPlaceholders = (container, placeholders) => {
  for (const child of childElements(container)) {
    if (isElement(child, PRESENTATIONML, "sp")) {
      const placeholder = readPlaceholder(firstChildElement(child, PRESENTATIONML, "nvSpPr"));

      if (placeholder) {
        placeholders.push({
          ...placeholder,
          listStyle: readListStyle(
            firstChildElement(firstChildElement(child, PRESENTATIONML, "txBody"), DRAWINGML, "lstStyle")
          ),
        });
      }
    } else if (isElement(child, PRESENTATIONML, "grpSp")) {
      collectPlaceholders(child, placeholders);
    }
  }

  return placeholders;
};

const readPlaceholders = (root) =>
  collectPlaceholders(
    firstChildElement(firstChildElement(root, PRESENTATIONML, "cSld"), PRESENTATIONML, "spTree"),
    []
  );

// The layout placeholder a slide placeholder takes its properties from: the
// one with its idx, else the first of its type.
const findLayoutPlaceholder = (placeholders, placeholder) =>
  (placeholder.idx !== null ? placeholders.find((candidate) => candidate.idx === placeholder.idx) : null) ??
  placeholders.find((candidate) => candidate.type === placeholder.type) ??
  null;

// The master holds one placeholder per kind: a title (title and centred
// title), a body (body, object and subtitle placeholders) and the date,
// footer and slide number ones.
const masterPlaceholderType = (type) =>
  TITLE_STYLE_PLACEHOLDER_TYPES.has(type) ? "title" : OTHER_STYLE_PLACEHOLDER_TYPES.has(type) ? type : "body";

/**
 * The list styles a slide's shapes inherit, from the slide's layout and
 * master (each parsed once per deck): readInheritance(slide) gives
 * (placeholder) => [layout placeholder's, master placeholder's, master text
 * style's] for a placeholder, [master's otherStyle] for any other shape. A
 * layout or master that is missing, of another kind or unreadable contributes
 * nothing: it only decides list markers, never whether the deck is read.
 */
const createInheritanceReader = (findPart) => {
  const parsed = new Map();
  const readPart = (partName, expectedLocal) => {
    if (!partName) {
      return null;
    }

    const located = findPart(partName);

    if (!located) {
      return null;
    }

    if (!parsed.has(located.name)) {
      let part = null;

      try {
        part = parseXmlPart(located);
      } catch {
        part = null;
      }

      parsed.set(located.name, part && isElement(part.root, PRESENTATIONML, expectedLocal) ? part : null);
    }

    return parsed.get(located.name);
  };
  const relatedPart = (part, kind, expectedLocal) => {
    let relationships = null;

    try {
      relationships = part ? readRelationships(findPart, part.name) : null;
    } catch {
      relationships = null;
    }

    const relationship = relationships?.list.find(
      (candidate) => candidate.kind === kind && !candidate.external && candidate.targetPartName
    );

    return relationship ? readPart(relationship.targetPartName, expectedLocal) : null;
  };
  const describedParts = new Map();
  const describe = (part, describePart) => {
    if (!part) {
      return null;
    }

    if (!describedParts.has(part.name)) {
      describedParts.set(part.name, describePart(part.root));
    }

    return describedParts.get(part.name);
  };
  const describeMaster = (root) => {
    const textStyles = firstChildElement(root, PRESENTATIONML, "txStyles");

    return {
      placeholders: readPlaceholders(root),
      styles: {
        body: readListStyle(firstChildElement(textStyles, PRESENTATIONML, "bodyStyle")),
        other: readListStyle(firstChildElement(textStyles, PRESENTATIONML, "otherStyle")),
        title: readListStyle(firstChildElement(textStyles, PRESENTATIONML, "titleStyle")),
      },
    };
  };

  return (slide) => {
    const layoutPart = relatedPart(slide, "slideLayout", "sldLayout");
    const layout = describe(layoutPart, (root) => ({ placeholders: readPlaceholders(root) }));
    const master = describe(relatedPart(layoutPart, "slideMaster", "sldMaster"), describeMaster);

    return (placeholder) => {
      if (!placeholder) {
        return [master?.styles.other ?? null];
      }

      const layoutPlaceholder = layout ? findLayoutPlaceholder(layout.placeholders, placeholder) : null;
      // A slide placeholder of the default type takes its kind from the
      // layout's (an "idx only" content placeholder over a body one).
      const type =
        placeholder.type === DEFAULT_PLACEHOLDER_TYPE && layoutPlaceholder ? layoutPlaceholder.type : placeholder.type;
      const masterType = masterPlaceholderType(type);
      const masterPlaceholder = master?.placeholders.find((candidate) => candidate.type === masterType) ?? null;
      const textStyle = TITLE_STYLE_PLACEHOLDER_TYPES.has(type)
        ? master?.styles.title
        : OTHER_STYLE_PLACEHOLDER_TYPES.has(type)
          ? master?.styles.other
          : master?.styles.body;

      return [layoutPlaceholder?.listStyle ?? null, masterPlaceholder?.listStyle ?? null, textStyle ?? null];
    };
  };
};

const NO_INHERITED_LIST_STYLES = () => [];

const compareNumbers = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// Top to bottom, then left to right, by each shape's own offset (a shape in a
// group is placed by its own offset, not transformed through the group's);
// shapes that state no position follow in document order.
const orderVisually = (shapes) => [
  ...shapes
    .filter((shape) => shape.offset)
    .sort(
      (left, right) =>
        compareNumbers(left.offset.y, right.offset.y) ||
        compareNumbers(left.offset.x, right.offset.x) ||
        left.index - right.index
    ),
  ...shapes.filter((shape) => !shape.offset),
];

const isHiddenSlide = (slide) => {
  const show = (getAttribute(slide, "show") ?? "").trim().toLowerCase();
  return show === "0" || show === "false";
};

/**
 * One page per visible slide, in deck order.
 *
 * @param {Map<string, Buffer>} parts ZIP entry name (no leading slash) -> bytes:
 *   _rels/.rels (it names the presentation part), ppt/**, [Content_Types].xml.
 * @param {{ maxTextChars?: number, presentationPart?: string }} options
 *   maxTextChars: the text all pages may hold together
 *   (RAG_OFFICE_MAX_TEXT_CHARS by default); presentationPart: the
 *   presentation part's name, as the archive guard resolved it (by default
 *   the officeDocument relationship of _rels/.rels, else ppt/presentation.xml).
 * @returns {Array<{ pageNumber: number, text: string, locationUnit: "slide", locationLabel?: string }>}
 *   pageNumber is the slide's 1-based position in p:sldIdLst (hidden slides
 *   keep their numbers and yield no page); text is the title, the other shapes
 *   in visual order, then "Notes:" and the speaker notes, one paragraph per
 *   line; locationLabel is the title text when the slide has one. A slide
 *   without any text yields no page.
 * @throws a DocumentFormatError (status 400, code DOCUMENT_ARCHIVE_INVALID) when the
 *   presentation part, its relationships, or a slide or notes page it refers to
 *   is missing, malformed or of the wrong kind; (413, DOCUMENT_ARCHIVE_TOO_LARGE)
 *   when the text runs past maxTextChars; a TypeError when `parts` is not a Map
 *   of Buffers.
 */
export const extractPptxPages = (parts, { maxTextChars = getOfficeMaxTextChars(), presentationPart } = {}) => {
  const findPart = createPartLookup(parts);
  // Table lines are spent as they are written (labels repeat on every row),
  // every page's whole text once the page is built.
  const tableBudget = createTextBudget(maxTextChars);
  const pageBudget = createTextBudget(maxTextChars);
  const readInheritance = createInheritanceReader(findPart);
  const notesContext = { inheritedListStyles: NO_INHERITED_LIST_STYLES, tableBudget };
  const presentationPartName = presentationPart || findPresentationPartName(findPart);
  const presentation = readXmlPart(findPart, presentationPartName);

  if (!presentation) {
    throw archiveError(REASONS.missingPresentation);
  }

  if (!isElement(presentation.root, PRESENTATIONML, "presentation")) {
    throw archiveError(REASONS.notPresentation);
  }

  const presentationRelationships = readRelationships(findPart, presentation.name);

  if (!presentationRelationships) {
    throw archiveError(REASONS.missingPresentationRelationships);
  }

  const slideIds = childElements(firstChildElement(presentation.root, PRESENTATIONML, "sldIdLst")).filter((child) =>
    isElement(child, PRESENTATIONML, "sldId")
  );
  // Each slide and notes page is read once, and a second reference is refused
  // before the part is parsed again: a part listed many times would let a small
  // file be extracted over and over.
  const readParts = new Set();
  const readReferencedPart = (partName, expectedLocal) => {
    if (!partName) {
      throw archiveError(REASONS.unresolvedReference);
    }

    const located = findPart(partName);

    if (!located) {
      throw archiveError(REASONS.missingPart);
    }

    if (readParts.has(located.name)) {
      throw archiveError(REASONS.duplicateReference);
    }

    readParts.add(located.name);
    const part = parseXmlPart(located);

    if (!isElement(part.root, PRESENTATIONML, expectedLocal)) {
      throw archiveError(REASONS.wrongPartKind);
    }

    return part;
  };
  const pages = [];

  slideIds.forEach((slideId, position) => {
    const relationship = presentationRelationships.byId.get(
      (getAttribute(slideId, "id", OFFICE_RELATIONSHIPS) ?? "").trim()
    );

    if (!relationship || relationship.external || relationship.kind !== "slide") {
      throw archiveError(REASONS.unresolvedReference);
    }

    const slide = readReferencedPart(relationship.targetPartName, "sld");

    if (isHiddenSlide(slide.root)) {
      return;
    }

    const shapes = readShapeTree(slide.root, SLIDE_SKIPPED_PLACEHOLDER_TYPES, {
      inheritedListStyles: readInheritance(slide),
      tableBudget,
    });
    const title = shapes.find((shape) => TITLE_PLACEHOLDER_TYPES.has(shape.placeholderType)) ?? null;
    const lines = [
      ...(title ? title.lines : []),
      ...orderVisually(shapes.filter((shape) => shape !== title)).flatMap((shape) => shape.lines),
    ];

    // A slide part without relationships has no notes page; the notes
    // relationship is the only one read here.
    const notesRelationship = readRelationships(findPart, slide.name)?.list.find(
      (candidate) => candidate.kind === "notesSlide" && !candidate.external
    );

    if (notesRelationship) {
      const notes = readReferencedPart(notesRelationship.targetPartName, "notes");
      const notesLines = orderVisually(readShapeTree(notes.root, NOTES_SKIPPED_PLACEHOLDER_TYPES, notesContext)).flatMap(
        (shape) => shape.lines
      );

      if (notesLines.length > 0) {
        lines.push(NOTES_HEADING);

        // One push per line (see childElements: no argument spread).
        for (const line of notesLines) {
          lines.push(line);
        }
      }
    }

    if (lines.length === 0) {
      return;
    }

    const page = {
      pageNumber: position + 1,
      text: lines.join("\n"),
      locationUnit: "slide",
    };

    pageBudget.spend(page.text.length);

    if (title) {
      page.locationLabel = normalizeLine(title.label);
    }

    pages.push(page);
  });

  return pages;
};
