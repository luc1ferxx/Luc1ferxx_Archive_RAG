// Word (.docx) pages: mammoth converts the document to HTML, and the HTML is
// flattened here into text lines and cut into sections, one page each.
//
//   Lines     a heading is its own line; a paragraph one line (a line break
//             inside it joins as a space); a list item "- text" (ordered and
//             nested lists alike); a table one line per row, the first row
//             as written ("Name; Amount") and every later row's cells
//             labelled by the first row ("Name: Alpha; Amount: 10"), a cell
//             under an empty header by its column letter; footnotes and
//             endnotes where mammoth puts them, after the body, as
//             "[n] text" to match the "[n]" mammoth leaves in the text.
//   Sections  cut at the highest heading level the document uses (the
//             smallest hN present): each section is a page whose text starts
//             with its heading line, locationLabel the heading's text. Text
//             before the first such heading is section 1, without a label. A
//             document without headings is one page.
//
// mammoth runs with external file access off, images dropped (never read),
// and the document's own embedded style map ignored, so the HTML depends on
// the file's text and this module alone. It does not convert page headers and
// footers, and comments are left out by its default style map: neither is
// extracted.
//
// Callers run the archive guard (rag/office/zip-guard.js) on the bytes first,
// and assertDocxXmlNesting on its scan; rag/office/office-document-pages.js
// does both.
import { createRequire } from "node:module";

import mammoth from "mammoth";

import { getOfficeMaxTextChars } from "../config.js";
import { createArchiveInvalidError } from "../document-format-errors.js";
import {
  buildHeaderLabels,
  createTextBudget,
  formatLabelledRow,
  formatPlainRow,
  normalizeLineText,
} from "./table-text.js";
import { MAX_OFFICE_XML_NESTING, measureXmlNestingDepth } from "./xml-nesting.js";
import { decodeXmlPart } from "./zip-guard.js";

export const DOCX_EXTRACTOR = "mammoth";
export const DOCX_LOCATION_UNIT = "section";

const require = createRequire(import.meta.url);
let mammothVersion = null;

/** The installed mammoth's version (its package.json), read once. */
export const getMammothVersion = () => {
  mammothVersion ??= require("mammoth/package.json").version;
  return mammothVersion;
};

// convertImage receives each picture and returns the HTML for it: nothing,
// and the picture's bytes are never read.
const dropImage = () => [];

const MAMMOTH_OPTIONS = Object.freeze({
  convertImage: dropImage,
  externalFileAccess: false,
  includeEmbeddedStyleMap: false,
});

/**
 * 400 DOCUMENT_ARCHIVE_INVALID when an XML part (.xml, .rels) of a Word
 * package nests its elements more than MAX_OFFICE_XML_NESTING deep. `archive`
 * is the archive guard's scan of the package (scanOfficeArchive); parts it did
 * not keep are inflated again from it, and together they are bounded by
 * RAG_OFFICE_MAX_XML_BYTES. mammoth walks the element tree recursively, so
 * without this bound how deep a document may nest would depend on the stack
 * of the thread that parses it (rag/office/xml-nesting.js).
 */
export const assertDocxXmlNesting = async (archive) => {
  for (const name of archive.fileNames) {
    if (!/\.(?:xml|rels)$/i.test(name)) {
      continue;
    }

    const bytes = archive.parts.get(name) ?? (await archive.readPart(name));

    if (bytes && measureXmlNestingDepth(decodeXmlPart(bytes), { limit: MAX_OFFICE_XML_NESTING }) > MAX_OFFICE_XML_NESTING) {
      throw createArchiveInvalidError(`an XML part nests its elements more than ${MAX_OFFICE_XML_NESTING} levels deep`);
    }
  }
};

/** mammoth's HTML for a .docx buffer. A file mammoth cannot read is 400 DOCUMENT_ARCHIVE_INVALID. */
export const convertDocxToHtml = async (buffer) => {
  try {
    const result = await mammoth.convertToHtml({ buffer }, MAMMOTH_OPTIONS);

    return result.value;
  } catch (error) {
    throw createArchiveInvalidError("the Word document cannot be read", { cause: error });
  }
};

// ---------------------------------------------------------------------------
// mammoth's HTML. Its writer (mammoth/lib/writers/html-writer.js) emits only
// <tag attr="value">, </tag> and <tag attr="value" /> for void elements, with
// &, <, > escaped in text and &, ", <, > in attribute values. So a tag never
// holds a raw '>' inside a value and text never a raw '<': this small parser
// reads that grammar exactly, without an HTML library.
// ---------------------------------------------------------------------------

const TOKEN_PATTERN = /<\/([A-Za-z][A-Za-z0-9]*)\s*>|<([A-Za-z][A-Za-z0-9]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)|</g;
const ATTRIBUTE_PATTERN = /([^\s=/>]+)(?:="([^"]*)")?/g;
const VOID_ELEMENTS = new Set(["br", "img", "input", "hr", "col", "wbr"]);
const NAMED_ENTITIES = Object.freeze({ amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' });

const fromCodePointOr = (codePoint, fallback) =>
  Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : fallback;

const decodeEntities = (text) =>
  text.replace(/&(#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g, (match, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return fromCodePointOr(Number.parseInt(entity.slice(2), 16), match);
    }

    if (entity.startsWith("#")) {
      return fromCodePointOr(Number.parseInt(entity.slice(1), 10), match);
    }

    return NAMED_ENTITIES[entity] ?? match;
  });

const parseAttributes = (source) => {
  const attributes = {};

  for (const [, name, value] of source.matchAll(ATTRIBUTE_PATTERN)) {
    attributes[name.toLowerCase()] = value === undefined ? "" : decodeEntities(value);
  }

  return attributes;
};

/** mammoth's HTML as a tree: [{ tag, attributes, children } | { text }]. */
export const parseMammothHtml = (html) => {
  const root = { children: [], tag: "#root" };
  const stack = [root];

  for (const [token, closingTag, openingTag, attributeSource, selfClosing, text] of String(html).matchAll(
    TOKEN_PATTERN
  )) {
    const parent = stack[stack.length - 1];

    if (text !== undefined || (closingTag === undefined && openingTag === undefined)) {
      parent.children.push({ text: decodeEntities(text ?? token) });
      continue;
    }

    if (closingTag !== undefined) {
      const tag = closingTag.toLowerCase();
      const index = stack.findLastIndex((node) => node.tag === tag);

      // A stray closing tag is ignored; one that closes an outer element
      // closes everything opened inside it.
      if (index > 0) {
        stack.length = index;
      }

      continue;
    }

    const node = { attributes: parseAttributes(attributeSource ?? ""), children: [], tag: openingTag.toLowerCase() };

    parent.children.push(node);

    if (!selfClosing && !VOID_ELEMENTS.has(node.tag)) {
      stack.push(node);
    }
  }

  return root.children;
};

// ---------------------------------------------------------------------------
// HTML -> blocks
// ---------------------------------------------------------------------------

const HEADING_LEVELS = Object.freeze({ h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 });
const BLOCK_TAGS = new Set([
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);
// A table can claim at most this many columns per cell (gridSpan), so a
// hostile span cannot make the column walk below run for long.
const MAX_COLUMN_SPAN = 1024;
const MAX_ROW_SPAN = 65_536;

const NOTE_ID_PATTERN = /^(?:footnote|endnote)-/;
const NOTE_BACK_LINK_PATTERN = /^#(?:footnote|endnote)-ref-/;

// The text inside a node: inline content joined as written, block boundaries
// and line breaks as spaces, a checkbox as [x] / [ ]; a note's back link (the
// "↑" mammoth appends to each note) is left out.
const collectText = (nodes, parts) => {
  for (const node of nodes) {
    if (node.text !== undefined) {
      parts.push(node.text);
      continue;
    }

    if (node.tag === "br") {
      parts.push(" ");
      continue;
    }

    if (node.tag === "input") {
      if (node.attributes.type === "checkbox") {
        parts.push(node.attributes.checked !== undefined ? " [x] " : " [ ] ");
      }

      continue;
    }

    if (node.tag === "a" && NOTE_BACK_LINK_PATTERN.test(node.attributes.href ?? "")) {
      continue;
    }

    const block = BLOCK_TAGS.has(node.tag);

    if (block) {
      parts.push(" ");
    }

    collectText(node.children, parts);

    if (block) {
      parts.push(" ");
    }
  }

  return parts;
};

const textOf = (nodes) => normalizeLineText(collectText(nodes, []).join(""));

const tableRowsOf = (node, rows = []) => {
  for (const child of node.children ?? []) {
    if (child.tag === "tr") {
      rows.push(child);
    } else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") {
      tableRowsOf(child, rows);
    }
  }

  return rows;
};

const readSpan = (value, maximum) => {
  const span = Number.parseInt(value ?? "1", 10);

  return Number.isFinite(span) && span > 1 ? Math.min(span, maximum) : 1;
};

// The table's rows as [{ column, span, text }] cells, columns placed as a
// browser would place them: a cell spanning rows from above occupies its
// columns in the rows below, and the next cell starts after it.
const readTableGrid = (table) => {
  const covered = new Map(); // column -> rows still covered below the current one
  const grid = [];

  for (const row of tableRowsOf(table)) {
    const cells = [];
    const startedHere = new Map();
    let column = 0;

    for (const cell of row.children.filter((child) => child.tag === "td" || child.tag === "th")) {
      while ((covered.get(column) ?? 0) > 0) {
        column += 1;
      }

      const span = readSpan(cell.attributes.colspan, MAX_COLUMN_SPAN);
      const rowSpan = readSpan(cell.attributes.rowspan, MAX_ROW_SPAN);

      cells.push({ column, span, text: textOf(cell.children) });

      if (rowSpan > 1) {
        for (let offset = 0; offset < span; offset += 1) {
          startedHere.set(column + offset, rowSpan - 1);
        }
      }

      column += span;
    }

    for (const [coveredColumn, remaining] of covered) {
      if (remaining > 1) {
        covered.set(coveredColumn, remaining - 1);
      } else {
        covered.delete(coveredColumn);
      }
    }

    for (const [startedColumn, remaining] of startedHere) {
      covered.set(startedColumn, remaining);
    }

    grid.push(cells);
  }

  return grid;
};

// The first row as written, then every later row labelled by it. Labels
// repeat on every row, so each line is spent from `budget` (a text budget,
// table-text.js) as it is written: a table cannot spell out more text than
// the document may hold before the limit stops it.
export const formatTableLines = (grid, budget = createTextBudget()) => {
  const [header, ...body] = grid;

  if (!header) {
    return [];
  }

  const labels = buildHeaderLabels(header);
  const lines = [];
  const addLine = (line) => {
    if (line) {
      budget.spend(line.length + 1);
      lines.push(line);
    }
  };

  addLine(formatPlainRow(header));

  for (const cells of body) {
    addLine(formatLabelledRow(cells, labels));
  }

  return lines;
};

const isNoteList = (node) =>
  node.tag === "ol" && node.children.some((child) => child.tag === "li" && NOTE_ID_PATTERN.test(child.attributes.id ?? ""));

const pushListItems = (list, blocks, budget) => {
  for (const item of list.children) {
    if (item.tag !== "li") {
      // Stray content inside a list: read it like any other block content.
      collectBlocks([item], blocks, budget);
      continue;
    }

    const nested = item.children.filter((child) => child.tag === "ul" || child.tag === "ol");
    const text = textOf(item.children.filter((child) => !nested.includes(child)));

    if (text) {
      blocks.push({ text: `- ${text}`, type: "line" });
    }

    for (const list of nested) {
      pushListItems(list, blocks, budget);
    }
  }
};

const collectBlocks = (nodes, blocks, budget) => {
  let inline = [];
  const flushInline = () => {
    const text = textOf(inline);

    if (text) {
      blocks.push({ text, type: "line" });
    }

    inline = [];
  };

  for (const node of nodes) {
    if (node.text !== undefined || !BLOCK_TAGS.has(node.tag)) {
      inline.push(node);
      continue;
    }

    flushInline();

    if (HEADING_LEVELS[node.tag]) {
      const text = textOf(node.children);

      // A heading without text (an image, say) neither prints nor cuts.
      if (text) {
        blocks.push({ level: HEADING_LEVELS[node.tag], text, type: "heading" });
      }

      continue;
    }

    if (isNoteList(node)) {
      // mammoth numbers its note markers [1], [2], ... in the order of this list.
      node.children
        .filter((child) => child.tag === "li")
        .forEach((note, index) => {
          const text = textOf(note.children);

          if (text) {
            blocks.push({ text: `[${index + 1}] ${text}`, type: "line" });
          }
        });
      continue;
    }

    if (node.tag === "ul" || node.tag === "ol") {
      pushListItems(node, blocks, budget);
      continue;
    }

    if (node.tag === "table") {
      for (const text of formatTableLines(readTableGrid(node), budget)) {
        blocks.push({ text, type: "line" });
      }

      continue;
    }

    if (node.tag === "dl") {
      // Comments, which mammoth emits only under a style map that asks for
      // them; never extracted.
      continue;
    }

    // p, blockquote, div, pre, and a stray li/tr/td: their content, inline
    // runs as one line each.
    collectBlocks(node.children, blocks, budget);
  }

  flushInline();
  return blocks;
};

/**
 * mammoth's HTML as blocks: [{ type: "heading", level, text } | { type: "line", text }].
 * `budget` (a text budget, table-text.js) is spent by table lines as they are
 * written; by default RAG_OFFICE_MAX_TEXT_CHARS.
 */
export const flattenMammothHtml = (html, { budget = createTextBudget() } = {}) =>
  collectBlocks(parseMammothHtml(html), [], budget);

/** Blocks cut into section pages (see the header of this module). */
export const splitDocxSections = (blocks) => {
  // A loop, never Math.min(...levels): a spread passes one argument per
  // heading, and past about 125,000 of them the call overflows the stack.
  let topLevel = null;

  for (const block of blocks) {
    if (block.type === "heading" && (topLevel === null || block.level < topLevel)) {
      topLevel = block.level;
    }
  }

  const sections = [];
  let current = { label: null, lines: [] };

  for (const block of blocks) {
    if (block.type === "heading" && block.level === topLevel) {
      if (current.lines.length > 0) {
        sections.push(current);
      }

      current = { label: block.text, lines: [block.text] };
      continue;
    }

    current.lines.push(block.text);
  }

  if (current.lines.length > 0) {
    sections.push(current);
  }

  return sections.map((section, index) => ({
    pageNumber: index + 1,
    text: section.lines.join("\n"),
    locationUnit: DOCX_LOCATION_UNIT,
    ...(section.label ? { locationLabel: section.label } : {}),
  }));
};

/**
 * A .docx buffer's pages: [{ pageNumber, text, locationUnit: "section",
 * locationLabel? }], deterministic for the same bytes and mammoth version.
 * An empty document has no pages. More text than `maxTextChars`
 * (RAG_OFFICE_MAX_TEXT_CHARS) across the pages is 413
 * DOCUMENT_ARCHIVE_TOO_LARGE: table lines are counted as they are written,
 * since their labels repeat, then the pages' whole text.
 */
export const extractDocxPages = async (buffer, { maxTextChars = getOfficeMaxTextChars() } = {}) => {
  const html = await convertDocxToHtml(buffer);
  const pages = splitDocxSections(flattenMammothHtml(html, { budget: createTextBudget(maxTextChars) }));
  const pageBudget = createTextBudget(maxTextChars);

  for (const page of pages) {
    pageBudget.spend(page.text.length);
  }

  return pages;
};
