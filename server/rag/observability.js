import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  isRagObservabilityEnabled,
  shouldIncludeRagObservabilityContext,
} from "./config.js";
import { getRagDataDirectory } from "./storage.js";

const EXCERPT_PREVIEW_LENGTH = 120;

const getObservabilityEventsPath = () =>
  path.join(path.dirname(getRagDataDirectory()), "rag-observability", "events.jsonl");

const normalizeWhitespace = (value = "") =>
  String(value).replace(/\s+/g, " ").trim();

const toTraceNumber = (value) => {
  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? Number(parsedValue.toFixed(6)) : null;
};

const getPageNumber = (metadata = {}) =>
  metadata.pageNumber ?? metadata.loc?.pageNumber ?? metadata.page ?? null;

const getResultDocument = (result = {}) => result.document ?? result;

const getResultText = (result = {}) => {
  const document = getResultDocument(result);

  return String(document.pageContent ?? result.pageContent ?? result.text ?? "");
};

const buildExcerptHash = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const buildExcerptPreview = (text) =>
  normalizeWhitespace(text).slice(0, EXCERPT_PREVIEW_LENGTH);

const buildAnchorGroupTrace = (anchorGroup = {}) => ({
  label: anchorGroup.label ?? null,
});

const buildResultListTrace = (results = []) =>
  (Array.isArray(results) ? results : []).map((result) => buildResultTrace(result));

const buildResultsByDocTrace = (resultsByDoc) => {
  if (!(resultsByDoc instanceof Map)) {
    return null;
  }

  return Object.fromEntries(
    [...resultsByDoc.entries()].map(([docId, results]) => [
      docId,
      buildResultListTrace(results),
    ])
  );
};

const buildRouteTrace = (route = {}) => ({
  rank: route.rank ?? null,
  route: route.route ?? null,
  score: toTraceNumber(route.score),
});

const buildProvenanceTrace = (provenance) => {
  if (!provenance || typeof provenance !== "object") {
    return null;
  }

  return {
    fusion: provenance.fusion
      ? {
          method: provenance.fusion.method ?? null,
          score: toTraceNumber(provenance.fusion.score),
        }
      : null,
    routes: (Array.isArray(provenance.routes) ? provenance.routes : []).map(
      buildRouteTrace
    ),
    queries: (Array.isArray(provenance.queries) ? provenance.queries : []).map(
      (query) => ({
        queryId: query.queryId ?? null,
        primary: Boolean(query.primary),
        fusion: query.fusion
          ? {
              method: query.fusion.method ?? null,
              score: toTraceNumber(query.fusion.score),
            }
          : null,
        routes: (Array.isArray(query.routes) ? query.routes : []).map(
          buildRouteTrace
        ),
      })
    ),
  };
};

export const buildResultTrace = (result = {}) => {
  const document = getResultDocument(result);
  const metadata = document.metadata ?? {};
  const text = getResultText(result);
  const trace = {
    rank: result.rank ?? null,
    docId: metadata.docId ?? null,
    fileName: metadata.fileName ?? "Unknown document",
    pageNumber: getPageNumber(metadata),
    chunkIndex: metadata.chunkIndex ?? null,
    sectionHeading: metadata.sectionHeading ?? null,
    score: toTraceNumber(result.score),
    vectorScore: toTraceNumber(result.vectorScore),
    sparseScore: toTraceNumber(result.sparseScore),
    keywordScore: toTraceNumber(result.keywordScore),
    originalScore: toTraceNumber(result.originalScore),
    rerankScore: toTraceNumber(result.rerankScore),
    // The evidence-admission signal and the raw RRF sum, kept separate from the
    // fusion `score` so a trace reader can tell the admission gate's input from the
    // ranking figure. admissionScore drives confidence; rrfScore is provenance only.
    admissionScore: toTraceNumber(result.admissionScore),
    rrfScore: toTraceNumber(result.rrfScore),
    excerptHash: buildExcerptHash(text),
    excerptPreview: buildExcerptPreview(text),
    // Where the candidate came from: each route that returned it (with the raw
    // rank and score on that route), the fusion that combined them, and every
    // retrieval query that surfaced it. Additive; absent for non-seam results.
    provenance: buildProvenanceTrace(result.provenance),
  };

  if (shouldIncludeRagObservabilityContext()) {
    trace.pageContent = text;
    trace.text = text;
  }

  return trace;
};

export const buildBundleTrace = (bundle = {}) => {
  const rankedResults = Array.isArray(bundle.rankedResults)
    ? bundle.rankedResults
    : [];

  return {
    sourceCount: rankedResults.length,
    sources: rankedResults.map((result) => buildResultTrace(result)),
    citations: (bundle.citations ?? []).map((citation) => ({
      rank: citation.rank ?? null,
      docId: citation.docId ?? null,
      fileName: citation.fileName ?? "Unknown document",
      pageNumber: citation.pageNumber ?? null,
      chunkIndex: citation.chunkIndex ?? null,
      sectionHeading: citation.sectionHeading ?? null,
      score: toTraceNumber(citation.score),
    })),
  };
};

export const buildConfidenceTrace = (confidence = {}) => {
  const trace = {
    confident: Boolean(confidence.confident),
    reason: confidence.reason ?? null,
    anchorGroups: (confidence.anchorGroups ?? []).map(buildAnchorGroupTrace),
    missingAnchorGroups: (confidence.missingAnchorGroups ?? []).map(
      buildAnchorGroupTrace
    ),
  };

  if (Array.isArray(confidence.usableResults)) {
    trace.usableResultCount = confidence.usableResults.length;
    trace.usableResults = buildResultListTrace(confidence.usableResults);
  }

  if (confidence.usableResultsByDoc instanceof Map) {
    trace.usableResultsByDoc = buildResultsByDocTrace(
      confidence.usableResultsByDoc
    );
    trace.usableResultCountsByDoc = Object.fromEntries(
      [...confidence.usableResultsByDoc.entries()].map(([docId, results]) => [
        docId,
        Array.isArray(results) ? results.length : 0,
      ])
    );
  }

  return trace;
};

export const recordRagTrace = async (event) => {
  if (!isRagObservabilityEnabled()) {
    return;
  }

  try {
    const eventsPath = getObservabilityEventsPath();

    await mkdir(path.dirname(eventsPath), { recursive: true });
    await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  } catch (error) {
    console.error("Failed to write RAG observability trace event.", error);
  }
};
