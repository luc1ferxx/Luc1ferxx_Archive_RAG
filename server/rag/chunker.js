import { getChunkOverlap, getChunkSize, getChunkStrategy } from "./config.js";
import { buildPublicFilePath } from "./document-utils.js";
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

const splitOversizedParagraph = (paragraph, chunkSize) => {
  if (paragraph.length <= chunkSize) {
    return [paragraph];
  }

  const sentences = paragraph
    .split(SENTENCE_BOUNDARY)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter(Boolean);

  if (sentences.length <= 1) {
    const slices = [];

    for (let cursor = 0; cursor < paragraph.length; cursor += chunkSize) {
      slices.push(paragraph.slice(cursor, cursor + chunkSize).trim());
    }

    return slices.filter(Boolean);
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
      segments.push(...splitOversizedParagraph(sentence, chunkSize));
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

const buildOverlapParagraphs = (paragraphs, overlapSize) => {
  const overlap = [];
  let currentLength = 0;

  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const paragraph = paragraphs[index];
    overlap.unshift(paragraph);
    currentLength += paragraph.length;

    if (currentLength >= overlapSize) {
      break;
    }
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
  const rawParagraphs = splitParagraphs(page.text).flatMap((paragraph) =>
    splitOversizedParagraph(paragraph, chunkSize)
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

    if (
      buffer.length === 0 &&
      leading.length > 0 &&
      getParagraphLength([...leading, paragraph]) > chunkSize
    ) {
      // The kept heading-like lines and this paragraph do not fit together;
      // the body chunk then looks exactly as it would without them.
      flushHeadingOnly();
    }

    const nextLength =
      getParagraphLength([...leading, ...buffer]) +
      paragraph.length +
      (leading.length + buffer.length > 0 ? 2 : 0);

    if (buffer.length > 0 && nextLength > chunkSize) {
      const overlap = buildOverlapParagraphs(buffer, chunkOverlap);
      flushBuffer();
      buffer = [...overlap, paragraph];
      continue;
    }

    buffer.push(paragraph);
  }

  if (buffer.length > 0) {
    flushBuffer();
  } else if (currentHeading !== null) {
    // Heading-like lines at the end of the page with no body after them on
    // this page. A heading never carries over to the next page, so they are
    // appended to this page's last chunk when they fit, or become a chunk of
    // their own.
    const trailing = [...leading, currentHeading];
    const previousLength = lastChunk
      ? getParagraphLength([
          ...lastChunk.leadingParagraphs,
          ...lastChunk.paragraphs,
        ])
      : 0;

    if (
      lastChunk &&
      previousLength + 2 + getParagraphLength(trailing) <= chunkSize
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

  for (const page of pages) {
    const pageChunks =
      chunkStrategy === "simple"
        ? chunkPageWithFixedWindows({
            docId,
            fileName,
            publicFilePath: resolvedPublicFilePath,
            page,
            source,
            chunkSize,
            chunkOverlap,
            startingChunkIndex: chunkIndex,
          })
        : chunkPageWithStructure({
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
