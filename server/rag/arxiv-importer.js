import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ARXIV_MAX_RESULTS,
  normalizeArxivMaxResults,
} from "./arxiv-client.js";

const DEFAULT_IMPORT_DELAY_MS = 1000;

const normalizeText = (value) => String(value ?? "").trim();

const sleep = (durationMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

const sanitizeFilePart = (value, fallbackValue) => {
  const sanitized = normalizeText(value)
    .replace(/v\d+$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return sanitized || fallbackValue;
};

export const buildArxivPdfFileName = (paper = {}) => {
  const arxivId = sanitizeFilePart(paper.arxivId, "paper");
  const title = sanitizeFilePart(paper.title, "untitled");

  return `arxiv-${arxivId}-${title}.pdf`;
};

const getExistingDocument = ({ fileName, ragService, accessScope }) => {
  const documents = ragService.listDocuments?.(accessScope) ?? [];

  return documents.find((document) => document.fileName === fileName) ?? null;
};

const serializeImportedPaper = ({ document, paper, status }) => ({
  arxivId: paper.arxivId,
  title: paper.title,
  absUrl: paper.absUrl,
  pdfUrl: paper.pdfUrl,
  published: paper.published,
  updated: paper.updated,
  primaryCategory: paper.primaryCategory,
  categories: paper.categories ?? [],
  authors: paper.authors ?? [],
  docId: document?.docId ?? null,
  fileName: document?.fileName ?? buildArxivPdfFileName(paper),
  status,
});

const serializeFailedPaper = ({ error, paper }) => ({
  arxivId: paper.arxivId,
  title: paper.title,
  absUrl: paper.absUrl,
  pdfUrl: paper.pdfUrl,
  error: error instanceof Error ? error.message : String(error),
});

const buildArxivDocumentSource = ({ importContext = {}, paper = {} } = {}) => ({
  sourceType: "arxiv",
  arxivId: normalizeText(paper.arxivId),
  relatedToDocId: normalizeText(importContext.relatedToDocId),
  importedByUserConfirmation: Boolean(importContext.importedByUserConfirmation),
});

export const importArxivTopic = async ({
  accessScope = {},
  arxivService,
  delayMs = DEFAULT_IMPORT_DELAY_MS,
  importContext = {},
  maxResults = DEFAULT_ARXIV_MAX_RESULTS,
  ragService,
  tempDirectory = path.join(os.tmpdir(), "luc1ferxx-arxiv-imports"),
  topic,
} = {}) => {
  const normalizedTopic = normalizeText(topic);

  if (!normalizedTopic) {
    const error = new Error("topic is required.");
    error.status = 400;
    throw error;
  }

  if (!arxivService?.search || !arxivService?.downloadPdf) {
    throw new Error("arXiv service is not configured.");
  }

  const requestedMaxResults = normalizeArxivMaxResults(maxResults);
  const papers = await arxivService.search({
    topic: normalizedTopic,
    maxResults: requestedMaxResults,
  });

  return importArxivPapers({
    accessScope,
    arxivService,
    delayMs,
    importContext,
    maxResults: requestedMaxResults,
    papers,
    ragService,
    tempDirectory,
    topic: normalizedTopic,
  });
};

export const importArxivPapers = async ({
  accessScope = {},
  arxivService,
  delayMs = DEFAULT_IMPORT_DELAY_MS,
  importContext = {},
  maxResults = DEFAULT_ARXIV_MAX_RESULTS,
  papers = [],
  ragService,
  tempDirectory = path.join(os.tmpdir(), "luc1ferxx-arxiv-imports"),
  topic = "",
} = {}) => {
  if (!arxivService?.downloadPdf) {
    throw new Error("arXiv service is not configured.");
  }

  if (!ragService?.ingestDocument) {
    throw new Error("Document ingestion service is not configured.");
  }

  if (!Array.isArray(papers)) {
    const error = new Error("papers must be an array.");
    error.status = 400;
    throw error;
  }

  const requestedMaxResults = normalizeArxivMaxResults(
    maxResults,
    papers.length || DEFAULT_ARXIV_MAX_RESULTS
  );
  const selectedPapers = papers.slice(0, requestedMaxResults);
  const importedPapers = [];
  const failedPapers = [];
  const skippedPapers = [];

  await mkdir(tempDirectory, {
    recursive: true,
  });

  for (const [index, paper] of selectedPapers.entries()) {
    const fileName = buildArxivPdfFileName(paper);
    const existingDocument = getExistingDocument({
      fileName,
      ragService,
      accessScope,
    });

    if (existingDocument) {
      skippedPapers.push(
        serializeImportedPaper({
          document: existingDocument,
          paper,
          status: "already_indexed",
        })
      );
      continue;
    }

    let pdfPath = null;

    try {
      const buffer = await arxivService.downloadPdf(paper);

      pdfPath = path.join(tempDirectory, `${randomUUID()}-${fileName}`);
      await writeFile(pdfPath, buffer);

      const document = await ragService.ingestDocument({
        docId: randomUUID(),
        filePath: pdfPath,
          fileName,
          ownerUserId: accessScope.userId,
          source: buildArxivDocumentSource({
            importContext,
            paper,
          }),
          workspaceId: accessScope.workspaceId,
        });

      importedPapers.push(
        serializeImportedPaper({
          document,
          paper,
          status: "imported",
        })
      );
    } catch (error) {
      failedPapers.push(
        serializeFailedPaper({
          error,
          paper,
        })
      );
    } finally {
      if (pdfPath) {
        await rm(pdfPath, {
          force: true,
        });
      }
    }

    if (delayMs > 0 && index < selectedPapers.length - 1) {
      await sleep(delayMs);
    }
  }

  return {
    topic: normalizeText(topic),
    requestedMaxResults,
    foundCount: selectedPapers.length,
    importedCount: importedPapers.length,
    skippedCount: skippedPapers.length,
    failedCount: failedPapers.length,
    importedPapers,
    skippedPapers,
    failedPapers,
  };
};

export const createArxivImportService = ({
  arxivService,
  delayMs,
  ragService,
  tempDirectory,
} = {}) => ({
  importPapers: (options = {}) =>
    importArxivPapers({
      arxivService,
      delayMs,
      ragService,
      tempDirectory,
      ...options,
    }),
  importTopic: (options = {}) =>
    importArxivTopic({
      arxivService,
      delayMs,
      ragService,
      tempDirectory,
      ...options,
    }),
});
