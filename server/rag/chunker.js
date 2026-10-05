import { getChunkOverlap, getChunkSize, getChunkStrategy } from "./config.js";
import { buildPublicFilePath } from "./document-utils.js";
import { splitLongSentence, splitSentenceSegments } from "./sentence-splitter.js";
import { normalizeWhitespace, splitParagraphs } from "./text-utils.js";

const SENTENCE_BOUNDARY = /(?<=[.!?\u3002\uff01\uff1f])\s+/;

const isLikelyHeading = (paragraph) => {
  if (!paragraph || paragraph.length > 90) {
    return false;
  }

  const compactParagraph = paragraph.replace(/\s+/g, " ").trim();
  const words = compactParagraph.split(/\s+/).filter(Boolean);

  if (words.length === 0 || words.length > 12) {
    return false;
  }

  if (/[:\uff1a]$/.test(compactParagraph)) {
    return true;
  }

  if (/^[0-9]+(\.[0-9]+)*\s+\S+/.test(compactParagraph)) {
    return true;
  }

  if (
    /^\u7b2c[\u4e00-\u9fa50-9]+[\u7ae0\u8282\u90e8\u5206\u6761\u6b3e]/.test(
      compactParagraph
    )
  ) {
    return true;
  }

  const titleCaseWordCount = words.filter((word) => /^[A-Z][A-Za-z0-9/-]*$/.test(word)).length;

  if (titleCaseWordCount === words.length && words.length >= 2 && words.length <= 8) {
    return true;
  }

  const alphaOnly = compactParagraph.replace(/[^A-Za-z]/g, "");

  if (!alphaOnly) {
    return false;
  }

  const uppercaseRatio =
    alphaOnly.split("").filter((character) => character === character.toUpperCase())
      .length / alphaOnly.length;

  return uppercaseRatio > 0.7;
};

// Cuts a paragraph longer than the chunk size into runs of whole sentences
// that fit it. A single sentence longer than the chunk size is cut at a
// clause or word boundary (splitLongSentence, as in the sentence chunker);
// its pieces are recorded in fragments so the overlap never carries one.
const splitOversizedParagraph = (paragraph, chunkSize, fragments) => {
  if (paragraph.length <= chunkSize) {
    return [paragraph];
  }

  const sentences = paragraph
    .split(SENTENCE_BOUNDARY)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter(Boolean);

  if (sentences.length <= 1) {
    const pieces = splitLongSentence(paragraph, chunkSize).map((piece) => piece.text);

    for (const piece of pieces) {
      fragments.add(piece);
    }

    return pieces;
  }

  const segments = [];
  let buffer = "";

  for (const sentence of sentences) {
    const candidate = buffer ? `${buffer} ${sentence}` : sentence;

    if (candidate.length > chunkSize && buffer) {
      segments.push(buffer);
      buffer = sentence;
      continue;
    }

    if (candidate.length > chunkSize) {
      segments.push(...splitOversizedParagraph(sentence, chunkSize, fragments));
      buffer = "";
      continue;
    }

    buffer = candidate;
  }

  if (buffer) {
    segments.push(buffer);
  }

  return segments.filter(Boolean);
};

const getParagraphLength = (paragraphs) =>
  paragraphs.reduce(
    (totalLength, paragraph, index) =>
      totalLength + paragraph.length + (index > 0 ? 2 : 0),
    0
  );

const joinSentenceSegments = (segments) =>
  segments.map((segment, index) => (index > 0 ? segment.separator : "") + segment.text).join("");

// The overlap a structured chunk hands to the next one: the trailing whole
// sentences of its body whose joined length (with the "\n\n" between
// paragraphs) fits overlapSize. Whole paragraphs are taken from the end while
// they fit, then the trailing sentences of the paragraph that does not
// (rag/sentence-splitter.js); nothing when not even the last sentence fits.
// A piece of a sentence that splitOversizedParagraph had to cut is never
// carried, and neither is anything before it.
const buildOverlapParagraphs = (paragraphs, overlapSize, fragments) => {
  const overlap = [];
  let currentLength = 0;

  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const paragraph = paragraphs[index];

    if (fragments.has(paragraph)) {
      break;
    }

    const separatorLength = overlap.length > 0 ? 2 : 0;

    if (currentLength + separatorLength + paragraph.length <= overlapSize) {
      overlap.unshift(paragraph);
      currentLength += separatorLength + paragraph.length;
      continue;
    }

    const segments = splitSentenceSegments(paragraph);
    const tail = [];
    let tailLength = 0;

    for (let segmentIndex = segments.length - 1; segmentIndex >= 1; segmentIndex -= 1) {
      const segment = segments[segmentIndex];
      const added = segment.text.length + (tail.length > 0 ? tail[0].separator.length : 0);

      if (currentLength + separatorLength + tailLength + added > overlapSize) {
        break;
      }

      tail.unshift(segment);
      tailLength += added;
    }

    if (tail.length > 0) {
      overlap.unshift(joinSentenceSegments(tail));
    }

    break;
  }

  return overlap;
};

const buildChunkText = (sectionHeading, paragraphs, leadingParagraphs = []) =>
  [...leadingParagraphs, ...(sectionHeading ? [sectionHeading] : []), ...paragraphs].join(
    "\n\n"
  );

const buildChunkRecord = ({
  docId,
  fileName,
  publicFilePath,
  pageNumber,
  chunkIndex,
  pageContent,
  sectionHeading = null,
  source = null,
}) => ({
  id: `${docId}:${chunkIndex}`,
  pageContent,
  metadata: {
    docId,
    fileName,
    filePath: publicFilePath,
    publicFilePath,
    pageNumber,
    chunkIndex,
    sectionHeading,
    ...(source ? { source } : {}),
  },
});

const chunkPageWithFixedWindows = ({
  docId,
  fileName,
  publicFilePath,
  page,
  source = null,
  chunkSize,
  chunkOverlap,
  startingChunkIndex,
}) => {
  const normalizedText = normalizeWhitespace(page.text);

  if (!normalizedText) {
    return {
      chunks: [],
      nextChunkIndex: startingChunkIndex,
    };
  }

  const chunks = [];
  const safeOverlap = Math.min(chunkOverlap, Math.max(0, chunkSize - 1));
  const step = Math.max(1, chunkSize - safeOverlap);
  let chunkIndex = startingChunkIndex;

  for (let start = 0; start < normalizedText.length; start += step) {
    const pageContent = normalizedText.slice(start, start + chunkSize).trim();

    if (!pageContent) {
      continue;
    }

    chunks.push(
      buildChunkRecord({
        docId,
        fileName,
        publicFilePath,
        pageNumber: page.pageNumber,
        chunkIndex,
        pageContent,
        source,
      })
    );
    chunkIndex += 1;

    if (start + chunkSize >= normalizedText.length) {
      break;
    }
  }

  return {
    chunks,
    nextChunkIndex: chunkIndex,
  };
};

const chunkPageWithStructure = ({
  docId,
  fileName,
  publicFilePath,
  page,
  source = null,
  chunkSize,
  chunkOverlap,
  startingChunkIndex,
}) => {
  const fragments = new Set();
  const rawParagraphs = splitParagraphs(page.text).flatMap((paragraph) =>
    splitOversizedParagraph(paragraph, chunkSize, fragments)
  );

  if (rawParagraphs.length === 0) {
    return {
      chunks: [],
      nextChunkIndex: startingChunkIndex,
    };
  }

  const chunks = [];
  let currentHeading = null;
  // Heading-like lines that were followed directly by another heading-like
  // line (table rows, "Label:" lead-ins, a chapter title above a section
  // title). They stay in reading order in front of the heading in force, so
  // the chunk keeps that heading as its sectionHeading while their text is
  // still indexed.
  let leading = [];
  let buffer = [];
  let chunkIndex = startingChunkIndex;
  // The parts of the last chunk this page emitted, so trailing heading-like
  // lines at the end of the page can be appended to it.
  let lastChunk = null;

  const pushChunk = ({ heading, leadingParagraphs, paragraphs }) => {
    const record = buildChunkRecord({
      docId,
      fileName,
      publicFilePath,
      pageNumber: page.pageNumber,
      chunkIndex,
      pageContent: buildChunkText(heading, paragraphs, leadingParagraphs),
      sectionHeading: heading,
      source,
    });

    chunks.push(record);
    lastChunk = {
      record,
      heading,
      leadingParagraphs: [...leadingParagraphs],
      paragraphs: [...paragraphs],
    };
    chunkIndex += 1;
  };

  const flushBuffer = () => {
    if (buffer.length === 0) {
      return;
    }

    pushChunk({
      heading: currentHeading,
      leadingParagraphs: leading,
      paragraphs: buffer,
    });
    leading = [];
  };

  // Emits the heading in force (and the heading-like lines kept in front of
  // it) as a chunk of its own, for when they cannot share a chunk with body
  // text without exceeding the chunk size.
  const flushHeadingOnly = () => {
    if (currentHeading === null && leading.length === 0) {
      return;
    }

    pushChunk({
      heading: currentHeading,
      leadingParagraphs: leading,
      paragraphs: [],
    });
    leading = [];
  };

  const getHeadingLength = () => (currentHeading === null ? 0 : currentHeading.length + 2);

  // The length a chunk would have with the parts given plus the heading in
  // force and the heading-like lines kept in front of it.
  const getChunkLength = (paragraphs) =>
    getParagraphLength([
      ...leading,
      ...(currentHeading === null ? [] : [currentHeading]),
      ...paragraphs,
    ]);

  const addBodyParagraph = (paragraph) => {
    if (
      buffer.length === 0 &&
      leading.length > 0 &&
      getChunkLength([paragraph]) > chunkSize
    ) {
      // The kept heading-like lines and this paragraph do not fit together;
      // the body chunk then looks exactly as it would without them.
      flushHeadingOnly();
    }

    if (buffer.length > 0 && getChunkLength([...buffer, paragraph]) > chunkSize) {
      // The overlap never makes the next chunk (its heading, the overlap and
      // this paragraph) longer than the chunk size.
      const overlap = buildOverlapParagraphs(
        buffer,
        Math.min(chunkOverlap, chunkSize - getHeadingLength() - paragraph.length - 2),
        fragments
      );
      flushBuffer();
      buffer = [...overlap, paragraph];
      return;
    }

    buffer.push(paragraph);
  };

  for (const paragraph of rawParagraphs) {
    if (isLikelyHeading(paragraph)) {
      if (buffer.length > 0) {
        flushBuffer();
        buffer = [];
      } else if (currentHeading !== null) {
        // The heading in force had no body text before this heading replaced
        // it: keep its text instead of dropping it.
        const kept = [...leading, currentHeading];

        if (getParagraphLength([...kept, paragraph]) > chunkSize) {
          flushHeadingOnly();
        } else {
          leading = kept;
        }
      }

      currentHeading = paragraph;
      continue;
    }

    // A paragraph that does not fit under the heading in force is cut like
    // an oversized one, to the room the heading leaves (unless the heading
    // takes more than half of the chunk size).
    const room = chunkSize - getHeadingLength();
    const pieces =
      paragraph.length > room && room >= chunkSize / 2
        ? splitOversizedParagraph(paragraph, room, fragments)
        : [paragraph];

    for (const piece of pieces) {
      addBodyParagraph(piece);
    }
  }

  if (buffer.length > 0) {
    flushBuffer();
  } else if (currentHeading !== null) {
    // Heading-like lines at the end of the page with no body after them on
    // this page. A heading never carries over to the next page, so they are
    // appended to this page's last chunk when they fit, or become a chunk of
    // their own.
    const trailing = [...leading, currentHeading];

    if (
      lastChunk &&
      lastChunk.record.pageContent.length + 2 + getParagraphLength(trailing) <= chunkSize
    ) {
      lastChunk.paragraphs.push(...trailing);
      lastChunk.record.pageContent = buildChunkText(
        lastChunk.heading,
        lastChunk.paragraphs,
        lastChunk.leadingParagraphs
      );
      leading = [];
    } else {
      flushHeadingOnly();
    }
  }

  return {
    chunks,
    nextChunkIndex: chunkIndex,
  };
};

// Sentence chunking (RAG_CHUNK_STRATEGY=sentence).
//
// Structure-aware like the structured chunker: every line of a page is tested
// with the same isLikelyHeading, a heading starts a section and is the
// sectionHeading of that section's chunks (repeated at the top of each), the
// heading-like lines without body text are kept as text under the same rules,
// and nothing carries over to the next page. Inside a section the body is
// packed from whole sentences:
// - The lines of one paragraph (blank-line separated) are joined into one
//   prose block, so a sentence broken across lines stays whole. A list item
//   (a line with a list marker, plus its continuation lines until a line
//   ends a sentence) and a table row (a line of mostly numeric cells, or
//   with a tab or "|") each form a block of their own and are never joined
//   with prose. Blocks are separated by a blank line in the chunk text.
// - Prose and list blocks are cut into sentences (rag/sentence-splitter.js);
//   a table row is one unit.
// - A chunk's whole pageContent (kept heading-like lines, heading and body)
//   never exceeds the chunk size. A unit longer than the room under the
//   heading is cut at a clause or word boundary into pieces that fit, and
//   only those pieces are not whole sentences.
// - The next chunk starts with the trailing whole sentences of the previous
//   chunk whose joined length fits the overlap (none if even the last one
//   does not fit, and never a piece of a cut sentence).
// Units keep the separator they had in the page text, so a chunk's body is a
// contiguous stretch of its section with whitespace collapsed.

const LIST_ITEM_PATTERN =
  /^(?:[•▪◦‣∙·●○■□\-–—*]\s|\(?(?:\d{1,3}|[a-z]|[ivxlc]{1,5})[.)]\s)/iu;
const NUMERIC_CELL = /^(?:[-+±~≈<>]?[(]?[$€£¥]?\d[\d.,]*[%‰]?[)]?[*†‡]*|[-–—]+)$/u;
const SENTENCE_FINAL_LINE_END =
  /[.!?…。！？；]["'”’)\]）」』]*$/u;

const isTableRowLine = (line) => {
  if (/\t|(?:^|\s)\|(?:\s|$)/.test(line)) {
    return true;
  }

  const cells = line.split(/\s+/).filter(Boolean);

  if (cells.length < 2 || SENTENCE_FINAL_LINE_END.test(line)) {
    return false;
  }

  const numericCells = cells.filter((cell) => NUMERIC_CELL.test(cell)).length;

  return numericCells >= 2 && numericCells * 2 >= cells.length;
};

const classifySentenceLine = (line) => {
  if (LIST_ITEM_PATTERN.test(line)) {
    return "list";
  }

  return isTableRowLine(line) ? "table" : "prose";
};

// The page as a sequence of heading lines and body blocks, in reading order.
// The lines are exactly the units splitParagraphs gives the structured
// chunker, so both strategies see the same headings.
const collectSentencePageEvents = (pageText) => {
  const events = [];
  let block = null;

  const closeBlock = () => {
    if (block) {
      events.push({ type: "block", block });
      block = null;
    }
  };

  for (const paragraph of normalizeWhitespace(String(pageText ?? "")).split(/\n{2,}/)) {
    closeBlock();

    for (const rawLine of paragraph.split("\n")) {
      const line = normalizeWhitespace(rawLine);

      if (!line) {
        continue;
      }

      if (isLikelyHeading(line)) {
        closeBlock();
        events.push({ type: "heading", text: line });
        continue;
      }

      const kind = classifySentenceLine(line);
      const continuesBlock =
        block !== null &&
        kind === "prose" &&
        (block.kind === "prose" ||
          (block.kind === "list" && !SENTENCE_FINAL_LINE_END.test(block.lines.at(-1))));

      if (!continuesBlock) {
        closeBlock();
        block = { kind, lines: [] };
      }

      block.lines.push(line);
    }
  }

  closeBlock();

  return events;
};

const getUnitsLength = (units) =>
  units.reduce(
    (length, unit, index) =>
      length + unit.text.length + (index > 0 ? unit.separator.length : 0),
    0
  );

const joinUnits = (units) =>
  units.map((unit, index) => (index > 0 ? unit.separator : "") + unit.text).join("");

const buildSectionUnits = (blocks, budget) => {
  const units = [];

  blocks.forEach((block, blockIndex) => {
    const text = block.lines.join(" ");
    const segments =
      block.kind === "table" ? [{ text, separator: "" }] : splitSentenceSegments(text);

    segments.forEach((segment, segmentIndex) => {
      const separator =
        segmentIndex > 0 ? segment.separator : blockIndex > 0 ? "\n\n" : "";

      if (segment.text.length <= budget) {
        units.push({ text: segment.text, separator, fragment: false });
        return;
      }

      splitLongSentence(segment.text, budget).forEach((piece, pieceIndex) => {
        units.push({
          text: piece.text,
          separator: pieceIndex === 0 ? separator : piece.separator,
          fragment: true,
        });
      });
    });
  });

  return units;
};

// The trailing whole sentences of a chunk body that fit the overlap; never
// the whole body and never a piece of a cut sentence.
const selectSentenceOverlap = (units, overlapSize) => {
  const overlap = [];
  let length = 0;

  for (let index = units.length - 1; index >= 1; index -= 1) {
    const unit = units[index];

    if (unit.fragment) {
      break;
    }

    const added = unit.text.length + (overlap.length > 0 ? overlap[0].separator.length : 0);

    if (length + added > overlapSize) {
      break;
    }

    overlap.unshift(unit);
    length += added;
  }

  return overlap;
};

const chunkPageWithSentences = ({
  docId,
  fileName,
  publicFilePath,
  page,
  source = null,
  chunkSize,
  chunkOverlap,
  startingChunkIndex,
}) => {
  const events = collectSentencePageEvents(page.text);
  const chunks = [];
  let chunkIndex = startingChunkIndex;
  let lastChunk = null;

  const pushChunk = (heading, parts) => {
    const record = buildChunkRecord({
      docId,
      fileName,
      publicFilePath,
      pageNumber: page.pageNumber,
      chunkIndex,
      pageContent: parts.filter((part) => part !== null && part !== "").join("\n\n"),
      sectionHeading: heading,
      source,
    });

    chunks.push(record);
    lastChunk = record;
    chunkIndex += 1;
  };

  // Heading-like lines emitted without body text. They fit one chunk unless a
  // single line is longer than the chunk size (a size under 90 characters);
  // such a line is cut like a long sentence, one piece per chunk.
  const pushLines = (heading, lines) => {
    if (getParagraphLength(lines) <= chunkSize) {
      pushChunk(heading, lines);
      return;
    }

    let current = [];

    const flush = () => {
      if (current.length > 0) {
        pushChunk(heading, current);
        current = [];
      }
    };

    for (const line of lines) {
      if (line.length > chunkSize) {
        flush();

        for (const piece of splitLongSentence(line, chunkSize)) {
          pushChunk(heading, [piece.text]);
        }

        continue;
      }

      if (current.length > 0 && getParagraphLength([...current, line]) > chunkSize) {
        flush();
      }

      current.push(line);
    }

    flush();
  };

  const emitSection = ({ heading, leading, blocks }) => {
    if (blocks.length === 0) {
      pushLines(heading, [...leading, heading]);
      return;
    }

    // The heading is repeated at the top of every chunk of its section unless
    // it would take more than half of the chunk size; it then becomes a chunk
    // of its own and the body chunks only carry it as sectionHeading.
    const repeatHeading = heading !== null && heading.length + 2 <= chunkSize / 2;
    const headingCost = repeatHeading ? heading.length + 2 : 0;
    const budget = Math.max(1, chunkSize - headingCost);
    let pendingLeading = leading;

    if (heading !== null && !repeatHeading) {
      pushLines(heading, [...pendingLeading, heading]);
      pendingLeading = [];
    }

    const getLeadingCost = () =>
      pendingLeading.length > 0 ? getParagraphLength(pendingLeading) + 2 : 0;
    let current = [];

    const emitCurrent = () => {
      pushChunk(heading, [
        ...pendingLeading,
        repeatHeading ? heading : null,
        joinUnits(current),
      ]);
      pendingLeading = [];
    };

    for (const unit of buildSectionUnits(blocks, budget)) {
      if (current.length === 0) {
        if (
          pendingLeading.length > 0 &&
          getLeadingCost() + headingCost + unit.text.length > chunkSize
        ) {
          // The kept heading-like lines do not fit with the first sentence.
          pushLines(heading, [...pendingLeading, heading]);
          pendingLeading = [];
        }

        current = [unit];
        continue;
      }

      const candidate = [...current, unit];

      if (getLeadingCost() + headingCost + getUnitsLength(candidate) <= chunkSize) {
        current = candidate;
        continue;
      }

      emitCurrent();
      let overlap = selectSentenceOverlap(current, chunkOverlap);

      while (
        overlap.length > 0 &&
        headingCost + getUnitsLength([...overlap, unit]) > chunkSize
      ) {
        overlap = overlap.slice(1);
      }

      current = [...overlap, unit];
    }

    if (current.length > 0) {
      emitCurrent();
    }
  };

  const sections = [];
  let section = { heading: null, leading: [], blocks: [] };

  for (const event of events) {
    if (event.type === "block") {
      section.blocks.push(event.block);
      continue;
    }

    const heading = event.text;

    if (section.blocks.length === 0 && section.heading !== null) {
      // The heading in force had no body text before this heading replaced
      // it: keep its text in front of the new heading, or give it a chunk of
      // its own when both do not fit together.
      const kept = [...section.leading, section.heading];

      if (getParagraphLength([...kept, heading]) > chunkSize) {
        sections.push({ heading: section.heading, leading: section.leading, blocks: [] });
        section = { heading, leading: [], blocks: [] };
      } else {
        section = { heading, leading: kept, blocks: [] };
      }

      continue;
    }

    if (section.blocks.length > 0) {
      sections.push(section);
    }

    section = { heading, leading: [], blocks: [] };
  }

  for (const entry of sections) {
    emitSection(entry);
  }

  if (section.blocks.length > 0) {
    emitSection(section);
  } else if (section.heading !== null) {
    // Heading-like lines at the end of the page with no body after them on
    // this page: appended to the page's last chunk when they fit, else a
    // chunk of their own.
    const trailing = [...section.leading, section.heading];

    if (
      lastChunk &&
      lastChunk.pageContent.length + 2 + getParagraphLength(trailing) <= chunkSize
    ) {
      lastChunk.pageContent = [lastChunk.pageContent, ...trailing].join("\n\n");
    } else {
      pushLines(section.heading, trailing);
    }
  }

  return {
    chunks,
    nextChunkIndex: chunkIndex,
  };
};

export const chunkDocumentWithConfig = ({
  docId,
  fileName,
  publicFilePath,
  pages,
  source = null,
  chunkSize,
  chunkOverlap,
  chunkStrategy,
}) => {
  const resolvedPublicFilePath =
    publicFilePath || buildPublicFilePath(docId);
  const chunks = [];
  let chunkIndex = 0;

  const chunkPage =
    chunkStrategy === "simple"
      ? chunkPageWithFixedWindows
      : chunkStrategy === "sentence"
        ? chunkPageWithSentences
        : chunkPageWithStructure;

  for (const page of pages) {
    const pageChunks = chunkPage({
      docId,
      fileName,
      publicFilePath: resolvedPublicFilePath,
      page,
      source,
      chunkSize,
      chunkOverlap,
      startingChunkIndex: chunkIndex,
    });

    chunks.push(...pageChunks.chunks);
    chunkIndex = pageChunks.nextChunkIndex;
  }

  return chunks;
};

export const chunkDocument = (input) =>
  chunkDocumentWithConfig({
    ...input,
    chunkSize: getChunkSize(),
    chunkOverlap: getChunkOverlap(),
    chunkStrategy: getChunkStrategy(),
  });

const tokenizeText = (value) => String(value ?? "").split(/\s+/).filter(Boolean);

// Only the first and last token of a chunk or of one of its paragraphs can be
// a piece of a longer token: a fixed window or an oversized-paragraph slice
// cuts there.
const collectBoundaryTokens = (pageContent) =>
  [pageContent, ...String(pageContent ?? "").split(/\n{2,}/)].flatMap((part) => {
    const tokens = tokenizeText(part);

    return tokens.length > 0 ? [tokens[0], tokens.at(-1)] : [];
  });

const isTokenCoveredByPieces = (token, pieces) => {
  // A token longer than one chunk, or cut by a fixed window, is split across
  // chunks (the pieces may overlap); it counts as indexed when the pieces
  // cover every character of it.
  const covered = new Array(token.length).fill(false);

  for (const piece of pieces) {
    for (
      let position = token.indexOf(piece);
      position !== -1;
      position = token.indexOf(piece, position + 1)
    ) {
      covered.fill(true, position, position + piece.length);
    }
  }

  return covered.every(Boolean);
};

// Lists the non-whitespace character sequences of a page's text that no chunk
// of that page contains, in page order. An empty list means every character of
// the page reached the index.
export const findUnindexedPageText = (page, chunks = []) => {
  const pageChunks = chunks.filter(
    (chunk) => chunk?.metadata?.pageNumber === page?.pageNumber
  );
  const chunkTokens = new Set(
    pageChunks.flatMap((chunk) => tokenizeText(chunk?.pageContent))
  );
  const pieces = [
    ...new Set(pageChunks.flatMap((chunk) => collectBoundaryTokens(chunk?.pageContent))),
  ];
  const unindexed = [];

  for (const token of tokenizeText(normalizeWhitespace(String(page?.text ?? "")))) {
    if (chunkTokens.has(token) || isTokenCoveredByPieces(token, pieces)) {
      continue;
    }

    unindexed.push(token);
  }

  return unindexed;
};
