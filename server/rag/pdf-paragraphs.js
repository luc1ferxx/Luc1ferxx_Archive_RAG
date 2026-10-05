import { isWrappedLineContinuation } from "./wrapped-lines.js";

// pdf.js paragraph detection (PDF_PARAGRAPH_DETECTION, pdf.js path only).
//
// pdf.js reports text items with their baseline, x position, width and font,
// and the legacy page text puts one "\n" at every baseline change, so each
// visual line of a paragraph reaches the chunker as its own unit. Here the
// same items are grouped into visual lines, consecutive lines are split into
// paragraphs from their geometry (a vertical gap larger than the page's usual
// line spacing, a font size or font change, a first-line indent, a list
// marker, a short line that ends a sentence), and the paragraphs are emitted
// separated by a blank line. Inside a paragraph a line break becomes a space
// only under the shared soft-wrap rule (wrapped-lines.js); every other break
// stays a single "\n". Only whitespace and removed line-end hyphens differ
// from the legacy text, and no character is reordered.

const SAME_LINE_BASELINE_TOLERANCE = 0.5; // of the font size: sub/superscripts
const SIZE_CHANGE_RATIO = 0.1;
const GAP_BREAK_RATIO = 1.3; // of the page's median line spacing
const FALLBACK_GAP_BREAK_RATIO = 2; // of the font size, without a median
const INDENT_RATIO = 0.5; // of the font size
const UNIFORM_FONT_SHARE = 0.9;
const SHORT_LINE_RATIO = 0.7; // of the page's median line width
// A blank stretch of at least this many font sizes between two runs of ink on
// one line is a table cell boundary (or a column gutter), never word spacing:
// on the local QASPER PDFs nearly every line with such a gap is a table row.
const CELL_GAP_RATIO = 1.5;
const CELL_GAP_EXEMPT_TAIL = /[.!?;:,。！？；：，]$/;

const LIST_MARKER_PATTERN =
  /^(?:[•▪◦‣∙·●○■□\-–—*]\s|\(?(?:\d{1,3}|[a-z]|[ivxlc]{1,5})[.)]\s)/iu;
const SENTENCE_END_PATTERN = /[.!?。！？:：]$/;

const sanitizeItemText = (value = "") => String(value).replace(/\u0000/g, "").replace(/\r/g, "");

const getItemFontSize = (item) => {
  const transform = item.transform ?? [];
  const size = Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0);

  return size > 0 ? size : Number(item.height) || 0;
};

const roundSize = (size) => Math.round(size * 2) / 2;

const median = (values) => {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const dominantKey = (weights) => {
  let bestKey = null;
  let bestWeight = -1;
  let total = 0;

  for (const [key, weight] of weights) {
    total += weight;

    if (weight > bestWeight) {
      bestKey = key;
      bestWeight = weight;
    }
  }

  return { key: bestKey, share: total > 0 ? bestWeight / total : 0 };
};

const finishLine = (line) => {
  const baseline = dominantKey(line.baselines);
  const size = dominantKey(line.sizes);
  const font = dominantKey(line.fonts);

  return {
    text: line.text,
    x: line.x,
    right: line.right,
    width: Math.max(0, line.right - line.x),
    y: Number(baseline.key),
    size: Number(size.key),
    font: font.key,
    fontShare: font.share,
    tabular: line.maxInkGap >= CELL_GAP_RATIO,
  };
};

const addWeight = (weights, key, weight) => {
  weights.set(key, (weights.get(key) ?? 0) + weight);
};

// Groups pdf.js text items into visual lines. Items on the same baseline are
// concatenated exactly as the legacy renderer does; an item whose baseline is
// within half a font size of the line's and that continues to the right (a
// superscript, a slightly shifted run) joins the line too, with a space when
// the horizontal gap shows one.
export const buildPdfTextLines = (items = []) => {
  const lines = [];
  let line = null;
  let lastY = null;

  for (const item of items) {
    const value = sanitizeItemText(item.str ?? "");

    if (!value) {
      continue;
    }

    const transform = item.transform ?? [];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const size = getItemFontSize(item);
    const width = Math.max(0, Number(item.width) || 0);
    const weight = value.replace(/\s+/g, "").length;
    const reference = line ? Math.max(size, line.referenceSize) : size;
    const sameBaseline = line !== null && y === lastY;
    const nearbyBaseline =
      line !== null &&
      !sameBaseline &&
      Math.abs(y - line.referenceY) <= SAME_LINE_BASELINE_TOLERANCE * reference &&
      x >= line.right - SAME_LINE_BASELINE_TOLERANCE * reference;

    if (sameBaseline || nearbyBaseline) {
      const needsSpace =
        nearbyBaseline &&
        x - line.right > 0.15 * reference &&
        !/\s$/.test(line.text) &&
        !/^\s/.test(value);

      // A wide gap after sentence or clause punctuation is justified prose
      // (sentence spacing, reference lists), not a cell boundary.
      if (weight > 0 && line.inkRight !== null && !CELL_GAP_EXEMPT_TAIL.test(line.text.trimEnd())) {
        line.maxInkGap = Math.max(line.maxInkGap, (x - line.inkRight) / Math.max(reference, 1));
      }

      line.text += `${needsSpace ? " " : ""}${value}`;
      line.right = Math.max(line.right, x + width);
    } else {
      if (line) {
        lines.push(finishLine(line));
      }

      line = {
        text: value,
        x,
        right: x + width,
        referenceY: y,
        referenceSize: size,
        inkRight: null,
        maxInkGap: 0,
        baselines: new Map(),
        sizes: new Map(),
        fonts: new Map(),
      };
    }

    if (weight > 0) {
      line.inkRight = Math.max(line.inkRight ?? -Infinity, x + width);
      addWeight(line.baselines, y, weight);
      addWeight(line.sizes, roundSize(size), weight);
      addWeight(line.fonts, item.fontName ?? "", weight);
    }

    lastY = y;
  }

  if (line) {
    lines.push(finishLine(line));
  }

  return lines
    .map((entry) => ({
      ...entry,
      text: entry.text.trim(),
      y: Number.isFinite(entry.y) ? entry.y : 0,
      size: Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0,
    }))
    .filter((entry) => entry.text);
};

const collectPageStatistics = (lines) => {
  const gapsBySize = new Map();
  const widthsBySize = new Map();

  lines.forEach((line, index) => {
    const sizeKey = roundSize(line.size);
    const widths = widthsBySize.get(sizeKey) ?? [];
    widths.push(line.width);
    widthsBySize.set(sizeKey, widths);

    if (index === 0) {
      return;
    }

    const previous = lines[index - 1];
    const gap = previous.y - line.y;

    if (roundSize(previous.size) === sizeKey && gap > 0 && gap < 2.5 * line.size) {
      const gaps = gapsBySize.get(sizeKey) ?? [];
      gaps.push(gap);
      gapsBySize.set(sizeKey, gaps);
    }
  });

  // Each median is computed once per font size: the break check asks for it
  // on every line, and re-sorting there made a page quadratic in its lines.
  const medianBySize = (valuesBySize) => {
    const medians = new Map(
      [...valuesBySize].map(([sizeKey, values]) => [sizeKey, median(values)])
    );

    return (size) => medians.get(roundSize(size)) ?? null;
  };

  return {
    lineGap: medianBySize(gapsBySize),
    lineWidth: medianBySize(widthsBySize),
  };
};

const startsWithListMarker = (text) => LIST_MARKER_PATTERN.test(text);

export const isPdfParagraphBreak = (previous, line, statistics) => {
  const size = Math.max(previous.size, line.size, 1);
  const gap = previous.y - line.y;

  // Same baseline or a jump upwards: a new column, a new text block, or
  // content stream order that does not follow the reading order.
  if (!(gap > SAME_LINE_BASELINE_TOLERANCE * size)) {
    return true;
  }

  if (Math.abs(previous.size - line.size) > Math.max(0.5, SIZE_CHANGE_RATIO * size)) {
    return true;
  }

  const lineGap = statistics.lineGap(line.size);

  if (lineGap ? gap > GAP_BREAK_RATIO * lineGap : gap > FALLBACK_GAP_BREAK_RATIO * size) {
    return true;
  }

  if (
    previous.font !== line.font &&
    previous.fontShare >= UNIFORM_FONT_SHARE &&
    line.fontShare >= UNIFORM_FONT_SHARE
  ) {
    return true;
  }

  if (startsWithListMarker(line.text)) {
    return true;
  }

  // A first-line indent starts a paragraph; a hanging indent under a list
  // item that continues in lowercase does not.
  if (
    line.x - previous.x > Math.max(1, INDENT_RATIO * size) &&
    !(startsWithListMarker(previous.text) && /^\p{Ll}/u.test(line.text))
  ) {
    return true;
  }

  const lineWidth = statistics.lineWidth(previous.size);

  return Boolean(
    lineWidth &&
      SENTENCE_END_PATTERN.test(previous.text) &&
      previous.width < SHORT_LINE_RATIO * lineWidth
  );
};

const WORD_PATTERN = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu;

// Every word of the document as written inside a line, hyphenated compounds
// included, so a line-end hyphen can be checked against how the document
// spells the word elsewhere.
export const buildHyphenationVocabulary = (pagesOfLines = []) => {
  const vocabulary = new Set();

  for (const lines of pagesOfLines) {
    for (const line of lines) {
      for (const word of line.text.toLowerCase().match(WORD_PATTERN) ?? []) {
        vocabulary.add(word);
      }
    }
  }

  return vocabulary;
};

const LINE_END_HYPHEN_PATTERN = /(?:^|[^\p{L}\p{N}-])([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)-$/u;

// "informa-" + "tion" is one word the line break split, so the hyphen goes.
// The hyphen stays when the word before it is already a compound
// ("state-of-the-" + "art"), when it does not end in a lowercase letter
// ("GPT-" + "based", "2019-" + "style"), or when the document spells the
// hyphenated form and never the joined one ("follow-up").
export const shouldDropLineEndHyphen = (previous = "", line = "", vocabulary = new Set()) => {
  const head = previous.match(LINE_END_HYPHEN_PATTERN)?.[1];
  const tail = line.match(/^\p{Ll}+/u)?.[0];

  if (!head || !tail || head.includes("-") || !/\p{Ll}$/u.test(head)) {
    return false;
  }

  const hyphenated = `${head}-${tail}`.toLowerCase();
  const joined = `${head}${tail}`.toLowerCase();

  return !(vocabulary.has(hyphenated) && !vocabulary.has(joined));
};

const joinParagraphLines = (lines, vocabulary) =>
  lines.reduce((joined, line, index) => {
    if (index === 0) {
      return line.text;
    }

    const previous = lines[index - 1].text;

    // Table rows stay one per line even when a row starts in lowercase.
    if (
      lines[index - 1].tabular ||
      line.tabular ||
      !isWrappedLineContinuation(previous, line.text)
    ) {
      return `${joined}\n${line.text}`;
    }

    if (previous.endsWith("-") && LINE_END_HYPHEN_PATTERN.test(previous)) {
      return shouldDropLineEndHyphen(previous, line.text, vocabulary)
        ? `${joined.slice(0, -1)}${line.text}`
        : `${joined}${line.text}`;
    }

    return `${joined} ${line.text}`;
  }, "");

const normalizeParagraphPageText = (text = "") =>
  text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const renderPdfParagraphText = (lines = [], { vocabulary = new Set() } = {}) => {
  if (lines.length === 0) {
    return "";
  }

  const statistics = collectPageStatistics(lines);
  const paragraphs = [[lines[0]]];

  for (let index = 1; index < lines.length; index += 1) {
    if (isPdfParagraphBreak(lines[index - 1], lines[index], statistics)) {
      paragraphs.push([lines[index]]);
    } else {
      paragraphs[paragraphs.length - 1].push(lines[index]);
    }
  }

  return normalizeParagraphPageText(
    paragraphs.map((paragraph) => joinParagraphLines(paragraph, vocabulary)).join("\n\n")
  );
};
