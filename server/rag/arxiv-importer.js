import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ARXIV_MAX_RESULTS,
  normalizeArxivMaxResults,
} from "./arxiv-client.js";
import {
  buildArxivPaperIdentity,
  findExistingArxivDocument,
} from "./arxiv-identity.js";
import { normalizeTrimmedText as normalizeText } from "../lib/normalize-text.js";

const DEFAULT_IMPORT_DELAY_MS = 1000;
const TASK_CLAIM_LOST = "TASK_CLAIM_LOST";

const isCooperativeAbortError = (error) =>
  error?.code === TASK_CLAIM_LOST || error?.name === "AbortError";

const assertExecutionActive = ({ assertClaimActive, signal } = {}) => {
  assertClaimActive?.();

  if (!signal?.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  const error = new Error("arXiv import was aborted.");

  error.name = "AbortError";
  throw error;
};

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

const getExistingDocument = ({ fileName, paper, ragService, accessScope }) => {
  const documents = ragService.listDocuments?.(accessScope) ?? [];

  return findExistingArxivDocument({
    documents,
    fileName,
    paper,
  });
};

const serializeImportedPaper = ({ document, duplicateMatch = null, paper, status }) => ({
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
  ...(duplicateMatch ? { duplicateMatch } : {}),
});

const serializeFailedPaper = ({ error, paper }) => ({
  arxivId: paper.arxivId,
  title: paper.title,
  absUrl: paper.absUrl,
  pdfUrl: paper.pdfUrl,
  error: error instanceof Error ? error.message : String(error),
});

const buildArxivDocumentSource = ({ importContext = {}, paper = {} } = {}) => {
  const identity = buildArxivPaperIdentity(paper);
  const source = {
    sourceType: "arxiv",
    arxivId: normalizeText(paper.arxivId),
    relatedToDocId: normalizeText(importContext.relatedToDocId),
    importedByUserConfirmation: Boolean(importContext.importedByUserConfirmation),
  };

  const absUrl = normalizeText(paper.absUrl);
  const pdfUrl = normalizeText(paper.pdfUrl);

  if (absUrl) {
    source.absUrl = absUrl;
  }

  if (pdfUrl) {
    source.pdfUrl = pdfUrl;
  }

  if (identity.titleHash) {
    source.titleHash = identity.titleHash;
  }

  return source;
};

export const importArxivTopic = async ({
  accessScope = {},
  arxivService,
  assertClaimActive,
  delayMs = DEFAULT_IMPORT_DELAY_MS,
  importContext = {},
  maxResults = DEFAULT_ARXIV_MAX_RESULTS,
  onPaperProgress,
  ragService,
  signal,
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
  assertExecutionActive({
    assertClaimActive,
    signal,
  });
  let papers = null;

  try {
    papers = await arxivService.search({
      topic: normalizedTopic,
      maxResults: requestedMaxResults,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      assertExecutionActive({
        assertClaimActive,
        signal,
      });
    }

    throw error;
  }
  assertExecutionActive({
    assertClaimActive,
    signal,
  });

  return importArxivPapers({
    accessScope,
    arxivService,
    assertClaimActive,
    delayMs,
    importContext,
    maxResults: requestedMaxResults,
    onPaperProgress,
    papers,
    ragService,
    signal,
    tempDirectory,
    topic: normalizedTopic,
  });
};

export const importArxivPapers = async ({
  accessScope = {},
  arxivService,
  assertClaimActive,
  delayMs = DEFAULT_IMPORT_DELAY_MS,
  importContext = {},
  maxResults = DEFAULT_ARXIV_MAX_RESULTS,
  onPaperProgress,
  papers = [],
  ragService,
  signal,
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
  const reportPaperProgress = async (event) => {
    assertExecutionActive({
      assertClaimActive,
      signal,
    });

    try {
      await onPaperProgress?.(event);
    } catch (error) {
      if (signal?.aborted) {
        assertExecutionActive({
          assertClaimActive,
          signal,
        });
      }

      if (isCooperativeAbortError(error)) {
        throw error;
      }

      // Progress reporting must not interrupt ingestion.
    }

    assertExecutionActive({
      assertClaimActive,
      signal,
    });
  };

  assertExecutionActive({
    assertClaimActive,
    signal,
  });
  await mkdir(tempDirectory, {
    recursive: true,
  });
  assertExecutionActive({
    assertClaimActive,
    signal,
  });

  for (const [index, paper] of selectedPapers.entries()) {
    assertExecutionActive({
      assertClaimActive,
      signal,
    });
    const fileName = buildArxivPdfFileName(paper);
    const existingDocument = getExistingDocument({
      fileName,
      paper,
      ragService,
      accessScope,
    });
    assertExecutionActive({
      assertClaimActive,
      signal,
    });

    if (existingDocument.document) {
      const skippedPaper = serializeImportedPaper({
        document: existingDocument.document,
        duplicateMatch: existingDocument.duplicateMatch,
        paper,
        status: "already_indexed",
      });

      skippedPapers.push(skippedPaper);
      await reportPaperProgress({
        paper,
        result: skippedPaper,
        status: "skipped",
      });
      continue;
    }

    let pdfPath = null;

    try {
      await reportPaperProgress({
        paper,
        status: "downloading",
      });
      assertExecutionActive({
        assertClaimActive,
        signal,
      });
      const buffer = await arxivService.downloadPdf(paper, {
        signal,
      });
      assertExecutionActive({
        assertClaimActive,
        signal,
      });

      pdfPath = path.join(tempDirectory, `${randomUUID()}-${fileName}`);
      assertExecutionActive({
        assertClaimActive,
        signal,
      });
      await writeFile(
        pdfPath,
        buffer,
        signal
          ? {
              signal,
            }
          : undefined
      );
      assertExecutionActive({
        assertClaimActive,
        signal,
      });

      await reportPaperProgress({
        paper,
        status: "ingesting",
      });
      assertExecutionActive({
        assertClaimActive,
        signal,
      });
      const document = await ragService.ingestDocument({
        docId: randomUUID(),
        filePath: pdfPath,
        fileName,
        ownerUserId: accessScope.userId,
        source: buildArxivDocumentSource({
          importContext,
          paper,
        }),
        signal,
        workspaceId: accessScope.workspaceId,
      });
      assertExecutionActive({
        assertClaimActive,
        signal,
      });

      const importedPaper = serializeImportedPaper({
        document,
        paper,
        status: "imported",
      });

      importedPapers.push(importedPaper);
      await reportPaperProgress({
        document,
        paper,
        result: importedPaper,
        status: "imported",
      });
    } catch (error) {
      if (signal?.aborted) {
        assertExecutionActive({
          assertClaimActive,
          signal,
        });
      }

      if (isCooperativeAbortError(error)) {
        throw error;
      }

      const failedPaper = serializeFailedPaper({
        error,
        paper,
      });

      failedPapers.push(failedPaper);
      await reportPaperProgress({
        error,
        paper,
        result: failedPaper,
        status: "failed",
      });
    } finally {
      if (pdfPath) {
        await rm(pdfPath, {
          force: true,
        });
      }
    }

    if (delayMs > 0 && index < selectedPapers.length - 1) {
      assertExecutionActive({
        assertClaimActive,
        signal,
      });
      await sleep(delayMs);
      assertExecutionActive({
        assertClaimActive,
        signal,
      });
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
