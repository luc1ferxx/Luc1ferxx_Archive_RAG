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

const buildChunkText = (sectionHeading, paragraphs) =>
  sectionHeading ? [sectionHeading, ...paragraphs].join("\n\n") : paragraphs.join("\n\n");

const buildChunkRecord = ({
  docId,
  fileName,
  filePath,
  publicFilePath,
  pageNumber,
  chunkIndex,
  pageContent,
  sectionHeading = null,
}) => ({
  id: `${docId}:${chunkIndex}`,
  pageContent,
  metadata: {
    docId,
    fileName,
    filePath,
    publicFilePath,
    pageNumber,
    chunkIndex,
    sectionHeading,
  },
});

const chunkPageWithFixedWindows = ({
  docId,
  fileName,
  filePath,
  publicFilePath,
  page,
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
        filePath,
        publicFilePath,
        pageNumber: page.pageNumber,
        chunkIndex,
        pageContent,
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
  filePath,
  publicFilePath,
  page,
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
  let buffer = [];
  let chunkIndex = startingChunkIndex;

  const flushBuffer = () => {
    if (buffer.length === 0) {
      return;
    }

    chunks.push(
      buildChunkRecord({
        docId,
        fileName,
        filePath,
        publicFilePath,
        pageNumber: page.pageNumber,
        chunkIndex,
        pageContent: buildChunkText(currentHeading, buffer),
        sectionHeading: currentHeading,
      })
    );

    chunkIndex += 1;
  };

  for (const paragraph of rawParagraphs) {
    if (isLikelyHeading(paragraph)) {
      flushBuffer();
      buffer = [];
      currentHeading = paragraph;
      continue;
    }

    const nextLength =
      getParagraphLength(buffer) + paragraph.length + (buffer.length > 0 ? 2 : 0);

    if (buffer.length > 0 && nextLength > chunkSize) {
      const overlap = buildOverlapParagraphs(buffer, chunkOverlap);
      flushBuffer();
      buffer = [...overlap, paragraph];
      continue;
    }

    buffer.push(paragraph);
  }

  flushBuffer();

  return {
    chunks,
    nextChunkIndex: chunkIndex,
  };
};

export const chunkDocument = ({ docId, fileName, filePath, pages }) => {
  const publicFilePath = buildPublicFilePath(filePath);
  const chunkSize = getChunkSize();
  const chunkOverlap = getChunkOverlap();
  const chunkStrategy = getChunkStrategy();
  const chunks = [];
  let chunkIndex = 0;

  for (const page of pages) {
    const pageChunks =
      chunkStrategy === "simple"
        ? chunkPageWithFixedWindows({
            docId,
            fileName,
            filePath,
            publicFilePath,
            page,
            chunkSize,
            chunkOverlap,
            startingChunkIndex: chunkIndex,
          })
        : chunkPageWithStructure({
            docId,
            fileName,
            filePath,
            publicFilePath,
            page,
            chunkSize,
            chunkOverlap,
            startingChunkIndex: chunkIndex,
          });

    chunks.push(...pageChunks.chunks);
    chunkIndex = pageChunks.nextChunkIndex;
  }

  return chunks;
};
